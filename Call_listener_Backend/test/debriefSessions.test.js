import test from "node:test";
import assert from "node:assert/strict";
import { createSessionHarness } from "./helpers/sessionHarness.js";

const READY = Object.freeze({
  status: "ready",
  review: { questionsCovered: [], strengths: ["Clear answers."], improvementTopics: [], followUpDraft: "" },
});

/** A debrief double the test settles by hand; it records the abort signal it got. */
function createControlledDebrief() {
  const calls = [];
  async function generateDebrief({ sessionId, signal }) {
    return new Promise((resolve) => {
      const call = { sessionId, signal, resolve };
      calls.push(call);
      signal.addEventListener("abort", () => resolve(null), { once: true });
    });
  }
  return { calls, generateDebrief };
}

function sessionIdFrom(socket) {
  return socket.outbound.find((message) => message.session)?.session.id;
}

async function startSession(capabilities) {
  const debrief = createControlledDebrief();
  const harness = createSessionHarness({ generateDebrief: debrief.generateDebrief });
  const socket = harness.connect();
  await harness.sendContext(socket, { capabilities });
  await socket.receive({ interviewer_question: "Why this team?" });
  await harness.settle();
  return { harness, socket, debrief };
}

test("a resumable session sends the sequenced debrief, then purges and cannot be resumed", async () => {
  const { harness, socket, debrief } = await startSession(["resume", "debrief"]);
  const sessionId = sessionIdFrom(socket);
  const ending = socket.receive({ end: { debrief: true } });
  await harness.waitUntil(() => debrief.calls.length === 1, "the debrief call");
  assert.deepEqual(harness.purged, [], "the transcript is kept until the debrief is sent");
  assert.equal(debrief.calls[0].sessionId, sessionId);
  debrief.calls[0].resolve(READY);
  await ending;

  const message = socket.outbound.at(-1);
  assert.deepEqual(message.debrief, READY);
  assert.ok(Number.isInteger(message.seq), "the debrief is sequenced like other session messages");
  assert.deepEqual(harness.purged, [sessionId]);
  assert.equal(harness.sessions.size, 0);
  assert.equal(await harness.ContextStore.get(sessionId), null);

  await socket.drop();
  const next = harness.connect();
  await next.receive({ resume: { sessionId, lastSeq: 0 } });
  assert.deepEqual(next.outbound, [{ error: "resume_expired" }]);
});

test("a socket close during the debrief aborts it and purges without a resume window", async () => {
  const { harness, socket, debrief } = await startSession(["resume", "debrief"]);
  const sessionId = sessionIdFrom(socket);
  const ending = socket.receive({ end: { debrief: true } });
  await harness.waitUntil(() => debrief.calls.length === 1, "the debrief call");
  const sentBefore = socket.raw.length;
  await socket.drop();
  await ending;

  assert.equal(debrief.calls[0].signal.aborted, true);
  assert.equal(socket.raw.length, sentBefore, "nothing is sent after the close");
  assert.ok(harness.purged.includes(sessionId));
  assert.equal(harness.sessions.size, 0);
  assert.deepEqual(harness.timers.active(), [], "no resume window is started");

  const next = harness.connect();
  await next.receive({ resume: { sessionId, lastSeq: 0 } });
  assert.deepEqual(next.outbound, [{ error: "resume_expired" }]);
});

test("a non-resumable session gets the debrief and is purged on close, as before", async () => {
  const { harness, socket, debrief } = await startSession(["debrief"]);
  const ending = socket.receive({ end: { debrief: true } });
  await harness.waitUntil(() => debrief.calls.length === 1, "the debrief call");
  debrief.calls[0].resolve(READY);
  await ending;
  assert.deepEqual(socket.outbound.at(-1), { debrief: READY });
  assert.equal(harness.purged.length, 0, "ordinary sessions purge on socket close");
  await socket.drop();
  assert.equal(harness.purged.length, 1);
  assert.equal(harness.sessions.size, 0);
});

test("a plain end of a resumable, debrief-capable session purges immediately with no debrief", async () => {
  const { harness, socket, debrief } = await startSession(["resume", "debrief"]);
  const sessionId = sessionIdFrom(socket);
  const sentBefore = socket.raw.length;
  await socket.receive({ end: true });
  assert.equal(debrief.calls.length, 0);
  assert.equal(socket.raw.length, sentBefore);
  assert.deepEqual(harness.purged, [sessionId]);
});

test("an explicit end keeps the words spoken just before it, so the debrief sees the final answer", async () => {
  const { silentPcmChunk } = await import("./helpers/fixtures.js");
  let history = null;
  const harness = createSessionHarness({
    generateDebrief: async ({ sessionId }) => {
      history = await harness.ChatHistory.get(sessionId);
      return READY;
    },
  });
  const socket = harness.connect();
  await harness.sendContext(socket, { capabilities: ["debrief"] });
  await socket.receive({ source: "mic", chunk: silentPcmChunk(1_920) });
  await harness.waitUntil(() => harness.deepgram.connections.length === 1, "the mic stream");
  const [connection] = harness.deepgram.connections;
  // Finalized but not yet ended by UtteranceEnd, plus audio Deepgram returns on Finalize.
  connection.emitTranscript("My final answer is that I would");
  connection.onFinalize = "measure it first.";

  await socket.receive({ end: { debrief: true } });

  assert.equal(connection.finalizeCalls, 1);
  assert.deepEqual(
    history.map(({ role, text }) => ({ role, text })),
    [{ role: "you", text: "My final answer is that I would measure it first." }]
  );
  assert.deepEqual(socket.outbound.filter((message) => message.speaker), [
    { speaker: "you", transcript: "My final answer is that I would measure it first." },
  ]);
  assert.deepEqual(socket.outbound.at(-1), { debrief: READY });
  await socket.drop();
});
