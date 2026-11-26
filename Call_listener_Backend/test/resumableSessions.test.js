import test from "node:test";
import assert from "node:assert/strict";
import { createSessionId, isSessionId, SESSION_ID_PATTERN } from "../server/services/session/sessionId.js";
import { createReplayBuffer } from "../server/services/session/replayBuffer.js";
import { isCommittedMessage, SessionChannel } from "../server/services/session/sessionChannel.js";
import {
  createSessionManager,
  SESSION_STATE,
  SESSION_TAKEN_OVER_CLOSE_CODE,
} from "../server/services/session/sessionManager.js";
import { parseResumeRequest } from "../server/websocket/handlers/connectionLifecycle.js";
import { requestsSessionResume } from "../server/contracts/interviewContext.js";
import { silentPcmChunk } from "./helpers/fixtures.js";
import { createSessionHarness, OTHER_OWNER, silentLog } from "./helpers/sessionHarness.js";

function sessionIdFrom(socket) {
  return socket.outbound.find((message) => message.session)?.session.id;
}

function lastSeqOf(socket) {
  return Math.max(0, ...socket.outbound.filter((m) => typeof m.seq === "number").map((m) => m.seq));
}

// --- Opaque IDs -------------------------------------------------------------

test("session IDs are 128-bit base64url strings with no collisions in a large sample", () => {
  const ids = new Set();
  for (let index = 0; index < 5_000; index += 1) {
    const id = createSessionId();
    assert.match(id, SESSION_ID_PATTERN);
    assert.equal(Buffer.from(id, "base64url").length, 16);
    ids.add(id);
  }
  assert.equal(ids.size, 5_000);
  assert.equal(isSessionId(Date.now().toString(36)), false, "the old time-based ID format is not an opaque ID");
  assert.equal(isSessionId(createSessionId()), true);
  assert.equal(isSessionId(42), false);
});

test("new sessions get opaque IDs and keep the chat/context Redis key names", async () => {
  const harness = createSessionHarness();
  const socket = harness.connect();
  await harness.sendContext(socket, { capabilities: [] });
  const [session] = [...harness.redis.ttls.keys()];
  assert.match(session, /^context:[A-Za-z0-9_-]{22}$/);
});

// --- Replay buffer and channel ---------------------------------------------

test("the replay buffer keeps the newest messages within count and byte bounds", () => {
  const buffer = createReplayBuffer({ maxMessages: 3, maxBytes: 1_000 });
  for (let seq = 1; seq <= 5; seq += 1) buffer.push(seq, `m${seq}`);
  assert.equal(buffer.size, 3);
  assert.deepEqual(buffer.since(0), { messages: ["m3", "m4", "m5"], truncated: true });
  assert.deepEqual(buffer.since(2), { messages: ["m3", "m4", "m5"], truncated: false });
  assert.deepEqual(buffer.since(4), { messages: ["m5"], truncated: false });
  assert.deepEqual(buffer.since(9), { messages: [], truncated: false });

  const bytes = createReplayBuffer({ maxMessages: 100, maxBytes: 10 });
  bytes.push(1, "aaaa");
  bytes.push(2, "bbbb");
  bytes.push(3, "cccc");
  assert.equal(bytes.bytes, 8);
  assert.deepEqual(bytes.since(0), { messages: ["bbbb", "cccc"], truncated: true });
  assert.equal(bytes.push(4, "x".repeat(11)), false, "a message larger than the whole buffer is not retained");
  assert.equal(bytes.since(3).truncated, true);

  assert.throws(() => createReplayBuffer({ maxMessages: 0 }), /maxMessages/);
  assert.throws(() => createReplayBuffer({ maxBytes: 0 }), /maxBytes/);
});

test("the default replay buffer is bounded to 200 messages and 256 KiB", () => {
  const buffer = createReplayBuffer();
  for (let seq = 1; seq <= 250; seq += 1) buffer.push(seq, "x");
  assert.equal(buffer.size, 200);
  const large = createReplayBuffer();
  for (let seq = 1; seq <= 100; seq += 1) large.push(seq, "y".repeat(4 * 1024));
  assert.ok(large.bytes <= 256 * 1024);
  assert.equal(large.size, 64);
});

test("only committed messages are replayable", () => {
  assert.equal(isCommittedMessage({ speaker: "caller", transcript: "Hi" }), true);
  assert.equal(isCommittedMessage({ ai_reply: "Done" }), true);
  assert.equal(isCommittedMessage({ generation: { state: "failed" }, ai_reply: "[Erreur du modèle]" }), true);
  assert.equal(isCommittedMessage({ error: "interview_budget_reached" }), true);
  assert.equal(isCommittedMessage({ generation: { id: "g1", state: "thinking" } }), false);
  assert.equal(isCommittedMessage({ generation: { id: "g1", state: "streaming" }, delta: "x" }), false);
});

test("an unsequenced channel forwards frames byte for byte", () => {
  const sent = [];
  const socket = { OPEN: 1, readyState: 1, send: (data) => sent.push(data) };
  const channel = new SessionChannel();
  assert.equal(channel.readyState, 3, "closed until a socket is attached");
  channel.attach(socket);
  assert.equal(channel.readyState, 1);
  channel.send('{"ai_reply":"x"}');
  assert.deepEqual(sent, ['{"ai_reply":"x"}']);
  channel.detach();
  channel.send('{"ai_reply":"y"}');
  assert.equal(sent.length, 1);
  assert.equal(channel.replay.size, 0);
});

test("a sequenced channel numbers every frame and retains committed ones while detached", () => {
  const channel = new SessionChannel();
  channel.enableSequencing();
  channel.send(JSON.stringify({ speaker: "caller", transcript: "Q?" }));
  channel.send(JSON.stringify({ generation: { id: "g1", state: "thinking" } }));
  channel.send(JSON.stringify({ generation: { id: "g1", state: "streaming" }, delta: "A" }));
  channel.send(JSON.stringify({ ai_reply: "A.", generation: { id: "g1", state: "done" } }));
  assert.equal(channel.readyState, 1, "a sequenced session accepts frames for replay while detached");
  assert.equal(channel.seq, 4);

  const sent = [];
  channel.attach({ OPEN: 1, readyState: 1, send: (data) => sent.push(JSON.parse(data)) });
  assert.deepEqual(channel.replaySince(0), { replayed: 2, truncated: false });
  assert.deepEqual(sent, [
    { speaker: "caller", transcript: "Q?", seq: 1 },
    { ai_reply: "A.", generation: { id: "g1", state: "done" }, seq: 4 },
  ]);
});

// --- Request parsing --------------------------------------------------------

test("resume requests are validated", () => {
  assert.equal(parseResumeRequest(Buffer.from("not json")), null);
  assert.equal(parseResumeRequest(Buffer.from('{"context":{}}')), null);
  assert.deepEqual(
    parseResumeRequest(Buffer.from('{"resume":{"sessionId":"abc","lastSeq":3}}')),
    { sessionId: "abc", lastSeq: 3 }
  );
  for (const resume of [null, {}, { sessionId: "abc" }, { sessionId: "", lastSeq: 0 },
    { sessionId: "abc", lastSeq: -1 }, { sessionId: "abc", lastSeq: 1.5 }, { sessionId: 7, lastSeq: 0 },
    { sessionId: "x".repeat(129), lastSeq: 0 }]) {
    assert.deepEqual(parseResumeRequest(Buffer.from(JSON.stringify({ resume }))), { invalid: true }, JSON.stringify(resume));
  }
});

test("the resume capability is read from the context capability list", () => {
  assert.equal(requestsSessionResume({ capabilities: ["stream", "resume"] }), true);
  assert.equal(requestsSessionResume({ capabilities: ["stream"] }), false);
  assert.equal(requestsSessionResume({}), false);
});

test("the session manager requires its dependencies", () => {
  assert.throws(() => createSessionManager(), /createStreamManager/);
  assert.throws(() => createSessionManager({ createStreamManager: () => ({}) }), /purgeSession/);
  assert.throws(
    () => createSessionManager({ createStreamManager: () => ({}), purgeSession: async () => {}, resumeWindowMs: -1 }),
    /resumeWindowMs/
  );
});

// --- Compatibility ----------------------------------------------------------

test("a client without the resume capability behaves exactly as before", async () => {
  const harness = createSessionHarness();
  const socket = harness.connect();
  await harness.sendContext(socket, { capabilities: ["stream"] });
  const call = await harness.ask(socket, "Why this role?");
  call.resolve("Because.");
  await harness.settle();

  assert.deepEqual(socket.outbound, [
    { ai_reply: "Intro." },
    { speaker: "caller", transcript: "Why this role?" },
    { generation: { id: "g1", state: "thinking" } },
    { ai_reply: "Because.", generation: { id: "g1", state: "done" } },
  ], "no session, seq, or notice fields");

  assert.equal(harness.purged.length, 0, "nothing purged while connected");
  await socket.drop();
  assert.equal(harness.purged.length, 1, "purged immediately on socket close");
  assert.equal(harness.sessions.size, 0);
  assert.equal(harness.timers.scheduled.length, 0, "no resume window");
  assert.equal(await harness.ContextStore.get(harness.purged[0]), null);

  const resumer = harness.connect();
  await resumer.receive({ resume: { sessionId: harness.purged[0], lastSeq: 0 } });
  assert.deepEqual(resumer.outbound, [{ error: "resume_expired" }]);
});

test("a resume request that is not the first frame is an invalid message", async () => {
  const harness = createSessionHarness();
  const socket = harness.connect();
  await harness.sendContext(socket);
  const sessionId = sessionIdFrom(socket);
  await socket.receive({ resume: { sessionId, lastSeq: 0 } });
  assert.deepEqual(socket.outbound.at(-1), { error: "Invalid message", seq: 2 });

  const malformed = harness.connect();
  await malformed.receive({ resume: { sessionId } });
  assert.deepEqual(malformed.outbound, [{ error: "Invalid message" }]);
});

// --- Resume lifecycle -------------------------------------------------------

test("a resume-capable session gets its ID once and sequenced messages", async () => {
  const harness = createSessionHarness();
  const socket = harness.connect();
  await harness.sendContext(socket, { capabilities: ["stream", "resume"] });
  await harness.sendContext(socket, { capabilities: ["stream", "resume"], introText: "Intro 2." });

  const [first, ...rest] = socket.outbound;
  assert.match(first.session.id, SESSION_ID_PATTERN);
  assert.deepEqual(rest, [{ ai_reply: "Intro.", seq: 1 }, { ai_reply: "Intro 2.", seq: 2 }]);
});

test("disconnect keeps the session; resume replays committed messages after lastSeq", async () => {
  const harness = createSessionHarness();
  const socket = harness.connect();
  await harness.sendContext(socket, { capabilities: ["stream", "resume"] });
  const sessionId = sessionIdFrom(socket);
  await socket.receive({ source: "mic", chunk: silentPcmChunk(320) });
  assert.equal(harness.deepgram.connections.length, 1);

  const call = await harness.ask(socket, "Tell me about Redis?");
  call.resolve("Mention the migration.");
  await harness.settle();
  const seenSeq = 1; // the client only saw the intro before the drop

  await socket.drop();
  const session = harness.sessions.get(sessionId);
  assert.equal(session.state, SESSION_STATE.DISCONNECTED);
  assert.equal(harness.purged.length, 0, "context and history survive the disconnect");
  assert.ok(await harness.ContextStore.get(sessionId));
  assert.equal(harness.deepgram.connections[0].finishCalls, 1, "transcription stream stopped");
  assert.equal(harness.timers.active().length, 1);
  assert.equal(harness.timers.active()[0].ms, 120_000);

  const resumed = harness.connect();
  await resumed.receive({ resume: { sessionId, lastSeq: seenSeq } });
  assert.deepEqual(resumed.outbound, [
    { speaker: "caller", transcript: "Tell me about Redis?", seq: 2 },
    { ai_reply: "Mention the migration.", generation: { id: "g1", state: "done" }, seq: 4 },
    { resumed: { sessionId, seq: 4 } },
    { notice: "audio_gap" },
  ], "thinking (seq 3) is transient and not replayed");
  assert.equal(session.state, SESSION_STATE.ACTIVE);
  assert.equal(harness.timers.active().length, 0, "resume window cancelled");

  // Context, history, and model choice are kept: the next question generates
  // with the stored context and continues the sequence.
  const next = await harness.ask(resumed, "And Kafka?");
  assert.match(next.history, /Tell me about Redis\?/);
  next.resolve("Talk about streams.");
  await harness.settle();
  assert.deepEqual(resumed.outbound.slice(4), [
    { speaker: "caller", transcript: "And Kafka?", seq: 5 },
    { generation: { id: "g2", state: "thinking" }, seq: 6 },
    { ai_reply: "Talk about streams.", generation: { id: "g2", state: "done" }, seq: 7 },
  ]);

  // Transcription reopens lazily on the next audio chunk.
  assert.equal(harness.deepgram.connections.length, 1);
  await resumed.receive({ source: "mic", chunk: silentPcmChunk(320) });
  assert.equal(harness.deepgram.connections.length, 2);
  assert.equal(harness.generator.calls.length, 3, "intro + two questions, nothing re-run");
});

test("a generation in flight at disconnect is reported failed and never re-run", async () => {
  const harness = createSessionHarness();
  const socket = harness.connect();
  await harness.sendContext(socket, { capabilities: ["stream", "resume"] });
  const sessionId = sessionIdFrom(socket);
  const call = await harness.ask(socket, "Why us?");
  const seenSeq = lastSeqOf(socket); // transcript + thinking were delivered

  await socket.drop();
  assert.equal(call.status, "aborted", "the paid request is cancelled");
  call.resolve("Too late.");

  const resumed = harness.connect();
  await resumed.receive({ resume: { sessionId, lastSeq: seenSeq } });
  await harness.settle();
  assert.deepEqual(resumed.outbound, [
    {
      generation: { id: "g1", state: "failed", reason: "disconnected" },
      ai_reply: "[Erreur du modèle]",
      seq: seenSeq + 1,
    },
    { resumed: { sessionId, seq: seenSeq + 1 } },
    { notice: "audio_gap" },
  ]);
  assert.equal(harness.generator.calls.length, 2, "no regeneration after resume");
  assert.deepEqual(harness.generator.pending(), []);
  const history = await harness.ChatHistory.toPrompt(sessionId);
  assert.doesNotMatch(history, /Too late/);
});

test("an intro in flight at disconnect is aborted and never sent", async () => {
  const harness = createSessionHarness();
  const socket = harness.connect();
  const sending = socket.receive({
    context: { version: 1, candidate: { name: "Ada" }, jobOffer: { title: "Dev" }, settings: {}, capabilities: ["resume"] },
  });
  await harness.waitUntil(() => harness.generator.calls.length === 1, "intro call");
  const sessionId = sessionIdFrom(socket);
  await socket.drop();
  await sending;
  assert.equal(harness.generator.calls[0].status, "aborted");

  const resumed = harness.connect();
  await resumed.receive({ resume: { sessionId, lastSeq: 0 } });
  assert.deepEqual(resumed.outbound, [{ resumed: { sessionId, seq: 0 } }, { notice: "audio_gap" }]);
});

test("a resume from a different owner is rejected and leaves the session resumable", async () => {
  const harness = createSessionHarness();
  const socket = harness.connect();
  await harness.sendContext(socket);
  const sessionId = sessionIdFrom(socket);
  await socket.drop();

  const intruder = harness.connect(OTHER_OWNER);
  await intruder.receive({ resume: { sessionId, lastSeq: 0 } });
  assert.deepEqual(intruder.outbound, [{ error: "resume_rejected" }]);
  assert.equal(intruder.closed, null, "the socket stays open for a fresh session");
  assert.equal(harness.sessions.get(sessionId).state, SESSION_STATE.DISCONNECTED);

  // The rejected socket continues as its own new session.
  await harness.sendContext(intruder);
  const freshId = sessionIdFrom(intruder);
  assert.notEqual(freshId, sessionId);
  assert.deepEqual(intruder.outbound.slice(2), [{ ai_reply: "Intro.", seq: 1 }]);

  const owner = harness.connect();
  await owner.receive({ resume: { sessionId, lastSeq: 1 } });
  assert.deepEqual(owner.outbound[0], { resumed: { sessionId, seq: 1 } });
});

test("the session is purged when the resume window elapses", async () => {
  const harness = createSessionHarness({ resumeWindowMs: 5_000 });
  const socket = harness.connect();
  await harness.sendContext(socket);
  const sessionId = sessionIdFrom(socket);
  await socket.receive({ source: "system", chunk: silentPcmChunk(320) });
  await socket.drop();
  assert.equal(harness.timers.active()[0].ms, 5_000);
  assert.ok(await harness.ContextStore.get(sessionId));

  await harness.timers.fireAll();
  assert.deepEqual(harness.purged, [sessionId]);
  assert.equal(await harness.ContextStore.get(sessionId), null);
  assert.equal(await harness.ChatHistory.toPrompt(sessionId), "");
  assert.equal(harness.sessions.get(sessionId), undefined);

  const late = harness.connect();
  await late.receive({ resume: { sessionId, lastSeq: 1 } });
  assert.deepEqual(late.outbound, [{ error: "resume_expired" }]);
  // The client then starts a new session on the same socket.
  await harness.sendContext(late);
  assert.notEqual(sessionIdFrom(late), sessionId);
});

test("explicit end purges immediately, unlike a disconnect", async () => {
  const harness = createSessionHarness();
  const socket = harness.connect();
  await harness.sendContext(socket);
  const sessionId = sessionIdFrom(socket);
  await socket.receive({ end: true });
  assert.deepEqual(harness.purged, [sessionId]);
  assert.equal(harness.sessions.get(sessionId), undefined);
  await socket.drop();
  assert.equal(harness.timers.scheduled.length, 0, "no resume window after end");

  const resumer = harness.connect();
  await resumer.receive({ resume: { sessionId, lastSeq: 0 } });
  assert.deepEqual(resumer.outbound, [{ error: "resume_expired" }]);
});

test("unknown session IDs answer resume_expired", async () => {
  const harness = createSessionHarness();
  const socket = harness.connect();
  await socket.receive({ resume: { sessionId: createSessionId(), lastSeq: 0 } });
  assert.deepEqual(socket.outbound, [{ error: "resume_expired" }]);
  await socket.drop();
  assert.equal(harness.purged.length, 0, "no session was ever created");
});

test("resuming a still-open session moves it to the new socket", async () => {
  const harness = createSessionHarness();
  const socket = harness.connect();
  await harness.sendContext(socket);
  const sessionId = sessionIdFrom(socket);

  const replacement = harness.connect();
  await replacement.receive({ resume: { sessionId, lastSeq: 1 } });
  assert.deepEqual(socket.closed, { code: SESSION_TAKEN_OVER_CLOSE_CODE, reason: "session_resumed_elsewhere" });
  assert.deepEqual(replacement.outbound[0], { resumed: { sessionId, seq: 1 } });

  // The old socket's late frames and close no longer affect the session.
  await socket.receive({ interviewer_question: "Ignored?" });
  await socket.drop();
  assert.equal(harness.generator.calls.length, 1);
  assert.equal(harness.sessions.get(sessionId).state, SESSION_STATE.ACTIVE);
  assert.equal(harness.timers.active().length, 0);
});

test("replay after a long disconnect reports truncation", async () => {
  const harness = createSessionHarness({ replayLimits: { maxMessages: 2, maxBytes: 64 * 1024 } });
  const socket = harness.connect();
  await harness.sendContext(socket);
  const sessionId = sessionIdFrom(socket);
  for (const question of ["One.", "Two.", "Three."]) {
    await socket.receive({ interviewer_question: question });
  }
  await socket.drop();
  const resumed = harness.connect();
  await resumed.receive({ resume: { sessionId, lastSeq: 0 } });
  assert.deepEqual(resumed.outbound, [
    { speaker: "caller", transcript: "Two.", seq: 3 },
    { speaker: "caller", transcript: "Three.", seq: 4 },
    { resumed: { sessionId, seq: 4, truncated: true } },
    { notice: "audio_gap" },
  ]);
});

test("a purge failure on expiry is logged, not thrown", async () => {
  const errors = [];
  const timers = { setTimeout: (fn) => ({ fn }), clearTimeout() {} };
  const sessions = createSessionManager({
    createStreamManager: () => ({ pause: async () => {}, closeAll: async () => {} }),
    purgeSession: async () => {
      throw new Error("redis down");
    },
    timers,
    log: { ...silentLog, error: (...args) => errors.push(args) },
  });
  const socket = { OPEN: 1, readyState: 1, send() {} };
  const session = sessions.create({ app_id: "a", device_id: "d" }, socket);
  sessions.enableResume(session);
  await sessions.disconnect(session, socket);
  session.expiryTimer.fn();
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 1);
  assert.equal(session.state, SESSION_STATE.EXPIRED);
});
