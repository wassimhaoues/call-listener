import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import jwt from "jsonwebtoken";
import WebSocket from "ws";
import { startWebSocketServer } from "../server/websocket/websocketServer.js";
import { SESSION_STATE } from "../server/services/session/sessionManager.js";
import { CANDIDATE_CONTEXT, createSessionHarness } from "./helpers/sessionHarness.js";

const config = {
  APP_ID: "com.coworky.calllistener",
  JWT_SECRET: "resume-test-secret-that-is-never-a-production-secret",
};

function issueToken(deviceId = "device-123") {
  return jwt.sign(
    { app_id: config.APP_ID, device_id: deviceId },
    config.JWT_SECRET,
    { issuer: "call-backend", audience: "call-electron", expiresIn: "5m" }
  );
}

/** A real `ws` client that records parsed frames and can await a predicate. */
async function openClient(baseUrl, deviceId) {
  const socket = new WebSocket(baseUrl, { headers: { cookie: `call_token=${issueToken(deviceId)}` } });
  const received = [];
  const waiters = [];
  socket.on("message", (data) => {
    received.push(JSON.parse(data.toString()));
    for (const waiter of [...waiters]) waiter();
  });
  await once(socket, "open");
  return {
    socket,
    received,
    send: (message) => socket.send(JSON.stringify(message)),
    waitFor(predicate, description) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}: ${JSON.stringify(received)}`)), 5_000);
        const check = () => {
          const match = received.find(predicate);
          if (!match) return;
          clearTimeout(timer);
          waiters.splice(waiters.indexOf(check), 1);
          resolve(match);
        };
        waiters.push(check);
        check();
      });
    },
  };
}

async function withResumeServer(run) {
  const harness = createSessionHarness();
  const wss = startWebSocketServer({ port: 0, config, handleAuthenticatedConnection: harness.handleConnection });
  await once(wss, "listening");
  const { port } = wss.address();
  try {
    await run(`ws://127.0.0.1:${port}`, harness);
  } finally {
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
  }
}

test("a dropped connection resumes over a real WebSocket without regenerating", async () => {
  await withResumeServer(async (baseUrl, harness) => {
    const first = await openClient(baseUrl);
    first.send({ context: { ...CANDIDATE_CONTEXT, capabilities: ["stream", "resume"] } });
    const { session } = await first.waitFor((m) => m.session, "the session ID");
    await harness.waitUntil(() => harness.generator.calls.length === 1, "the intro call");
    harness.generator.calls[0].resolve("Intro.");
    const intro = await first.waitFor((m) => m.ai_reply === "Intro.", "the intro");
    assert.equal(intro.seq, 1);

    first.send({ interviewer_question: "Why Redis?" });
    await harness.waitUntil(() => harness.generator.calls.length === 2, "the reply call");
    // The transport drops while the answer is being generated.
    first.socket.terminate();
    await harness.waitUntil(
      () => harness.sessions.get(session.id)?.state === SESSION_STATE.DISCONNECTED,
      "the server to see the disconnect"
    );
    assert.equal(harness.generator.calls[1].status, "aborted");

    const second = await openClient(baseUrl);
    second.send({ resume: { sessionId: session.id, lastSeq: intro.seq } });
    const { resumed } = await second.waitFor((m) => m.resumed, "the resume acknowledgement");
    await second.waitFor((m) => m.notice === "audio_gap", "the audio gap notice");
    assert.deepEqual(second.received.slice(0, 3), [
      { speaker: "caller", transcript: "Why Redis?", seq: 2 },
      { generation: { id: "g1", state: "failed", reason: "disconnected" }, ai_reply: "[Erreur du modèle]", seq: 4 },
      { resumed: { sessionId: session.id, seq: 4 } },
    ]);
    assert.equal(resumed.seq, 4);
    assert.equal(harness.generator.calls.length, 2, "the interrupted generation is not re-run");

    // The resumed session keeps working on the new socket.
    second.send({ interviewer_question: "And Kafka?" });
    await harness.waitUntil(() => harness.generator.calls.length === 3, "the next reply call");
    harness.generator.calls[2].resolve("Streams.");
    const reply = await second.waitFor((m) => m.ai_reply === "Streams.", "the next reply");
    assert.equal(reply.seq, 7);
    assert.equal(first.received.some((m) => m.ai_reply === "Streams."), false);
    second.socket.close();
  });
});

test("another device cannot resume the session", async () => {
  await withResumeServer(async (baseUrl, harness) => {
    const owner = await openClient(baseUrl, "device-owner");
    owner.send({ context: { ...CANDIDATE_CONTEXT, capabilities: ["resume"] } });
    const { session } = await owner.waitFor((m) => m.session, "the session ID");
    await harness.waitUntil(() => harness.generator.calls.length === 1, "the intro call");
    harness.generator.calls[0].resolve("Intro.");
    await owner.waitFor((m) => m.ai_reply, "the intro");
    owner.socket.terminate();
    await harness.waitUntil(
      () => harness.sessions.get(session.id)?.state === SESSION_STATE.DISCONNECTED,
      "the disconnect"
    );

    const intruder = await openClient(baseUrl, "device-other");
    intruder.send({ resume: { sessionId: session.id, lastSeq: 0 } });
    await intruder.waitFor((m) => m.error === "resume_rejected", "the rejection");
    assert.equal(intruder.received.some((m) => m.ai_reply), false, "nothing replayed to another owner");
    assert.equal(intruder.socket.readyState, WebSocket.OPEN);
    assert.equal(harness.sessions.get(session.id).state, SESSION_STATE.DISCONNECTED);
    intruder.socket.close();
  });
});
