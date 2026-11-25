import test from "node:test";
import assert from "node:assert/strict";
import {
  createMessageHandler,
  isValidAudioMessage,
  isValidTypedInterviewerQuestion,
  MAX_AUDIO_CHUNK_BYTES,
  MAX_TYPED_INTERVIEWER_QUESTION_CHARS,
} from "../server/websocket/handlers/messageHandler.js";

function createHarness({ isModelAllowed } = {}) {
  const calls = {
    contexts: [],
    prompts: [],
    replies: [],
    chunks: [],
    typedQuestions: [],
    listeners: 0,
    closes: 0,
  };
  const sent = [];
  const wsClient = {
    OPEN: 1,
    readyState: 1,
    send: (payload) => sent.push(JSON.parse(payload)),
  };
  const streamManager = {
    closeAll: async () => { calls.closes += 1; },
    sendChunk: async (source, chunk) => calls.chunks.push({ source, chunk }),
    ensureListeners: async () => { calls.listeners += 1; },
    submitInterviewerQuestion: async (question) => calls.typedQuestions.push(question),
  };
  const handler = createMessageHandler({
    ChatHistory: { toPrompt: async () => "candidate: I led the migration" },
    ContextStore: {
      set: async (sessionId, context) => calls.contexts.push({ sessionId, context }),
    },
    buildPrompt: (context, mode) => {
      calls.prompts.push({ context, mode });
      return "prompt";
    },
    generateReply: async (prompt, history, options = {}) => {
      calls.replies.push({ prompt, history });
      if (options.model) {
        calls.models = [...(calls.models || []), options.model];
        options.onModel?.({ selected: options.model, actual: `${options.model}-2026` });
      }
      return "Use one concise STAR example.";
    },
    isModelAllowed,
    log: { info() {}, warn() {}, error() {} },
  });

  return {
    calls,
    sent,
    run: (message) => handler({
      wsClient,
      sessionId: "session-1",
      data: Buffer.from(JSON.stringify(message)),
      streamManager,
    }),
    runRaw: (raw) => handler({
      wsClient,
      sessionId: "session-1",
      data: Buffer.from(raw),
      streamManager,
    }),
  };
}

test("accepts the supported audio chunk representations", () => {
  assert.equal(isValidAudioMessage({ source: "mic", chunk: "AAE=" }), true);
  assert.equal(isValidAudioMessage({ source: "system", chunk: [0, 1] }), true);
  assert.equal(isValidAudioMessage({ source: "other", chunk: "AAE=" }), false);
  assert.equal(isValidAudioMessage({ source: "mic" }), false);
});

test("accepts bounded typed interviewer questions only", () => {
  assert.equal(isValidTypedInterviewerQuestion({ interviewer_question: "How did you lead the migration?" }), true);
  assert.equal(isValidTypedInterviewerQuestion({ interviewer_question: "  " }), false);
  assert.equal(
    isValidTypedInterviewerQuestion({ interviewer_question: "x".repeat(MAX_TYPED_INTERVIEWER_QUESTION_CHARS + 1) }),
    false
  );
});

test("stores context and returns the intro suggestion", async () => {
  const harness = createHarness();
  const context = { candidate: "Ada", jobOffer: "Platform engineer" };

  await harness.run({ context });

  assert.deepEqual(harness.calls.contexts, [{ sessionId: "session-1", context }]);
  assert.deepEqual(harness.calls.prompts, [
    { context: JSON.stringify(context), mode: "intro" },
  ]);
  assert.deepEqual(harness.calls.replies, [
    { prompt: "prompt", history: "candidate: I led the migration" },
  ]);
  assert.deepEqual(harness.sent, [{ ai_reply: "Use one concise STAR example." }]);
});

test("rejects a model outside the allowlist without storing context or generating", async () => {
  const harness = createHarness({ isModelAllowed: (id) => id === "openai/gpt-5.6-luna" });

  await harness.run({ context: { settings: { model: "other/model" } } });

  assert.deepEqual(harness.calls.contexts, []);
  assert.deepEqual(harness.calls.replies, []);
  assert.deepEqual(harness.sent, [{ error: "unsupported_model" }]);
});

test("rejects any explicit model when no allowlist is injected", async () => {
  const harness = createHarness();
  await harness.run({ context: { settings: { model: "openai/gpt-5.6-luna" } } });
  assert.deepEqual(harness.sent, [{ error: "unsupported_model" }]);
});

test("pins an allowlisted model for the intro and reports selected and actual IDs", async () => {
  const harness = createHarness({ isModelAllowed: (id) => id === "openai/gpt-5.6-luna" });
  const context = { settings: { model: "openai/gpt-5.6-luna" } };

  await harness.run({ context });

  assert.deepEqual(harness.calls.contexts, [{ sessionId: "session-1", context }]);
  assert.deepEqual(harness.calls.models, ["openai/gpt-5.6-luna"]);
  assert.deepEqual(harness.sent, [{
    ai_reply: "Use one concise STAR example.",
    model: { selected: "openai/gpt-5.6-luna", actual: "openai/gpt-5.6-luna-2026" },
  }]);
});

test("does not generate an introduction after the session budget is exhausted", async () => {
  const sent = [];
  let generated = false;
  const handler = createMessageHandler({
    ChatHistory: { toPrompt: async () => "" },
    ContextStore: { set: async () => {} },
    buildPrompt: () => "prompt",
    generateReply: async () => { generated = true; return "should not be used"; },
    Budget: { canGenerate: async () => ({ allowed: false }) },
    log: { info() {}, warn() {}, error() {} },
  });
  await handler({
    wsClient: { OPEN: 1, readyState: 1, send: (payload) => sent.push(JSON.parse(payload)) },
    sessionId: "session-1",
    data: Buffer.from(JSON.stringify({ context: { candidate: "Ada" } })),
    streamManager: {},
  });
  assert.equal(generated, false);
  assert.deepEqual(sent, [{ error: "interview_budget_reached" }]);
});

test("normalizes audio and initializes listeners once per received message", async () => {
  const harness = createHarness();

  await harness.run({
    source: "system",
    chunk: Buffer.from([0, 1, 2]).toString("base64"),
  });

  assert.equal(harness.calls.chunks.length, 1);
  assert.equal(harness.calls.chunks[0].source, "system");
  assert.deepEqual([...harness.calls.chunks[0].chunk], [0, 1, 2]);
  assert.equal(harness.calls.listeners, 1);
  assert.deepEqual(harness.sent, []);
});

test("submits a typed interviewer question without creating an audio stream", async () => {
  const harness = createHarness();

  await harness.run({ interviewer_question: "  How did you handle Redis failures?  " });

  assert.deepEqual(harness.calls.typedQuestions, ["How did you handle Redis failures?"]);
  assert.deepEqual(harness.calls.chunks, []);
  assert.equal(harness.calls.listeners, 0);
});

test("ends streams and reports malformed protocol input safely", async () => {
  const harness = createHarness();

  await harness.run({ end: true });
  await harness.run({ source: "invalid", chunk: "AAE=" });
  await harness.runRaw("not-json");

  assert.equal(harness.calls.closes, 1);
  assert.deepEqual(harness.sent, [
    { error: "Invalid message" },
    { error: "Invalid message" },
  ]);
});

test("rejects empty and oversized audio chunks before transcription starts", async () => {
  const harness = createHarness();

  await harness.run({ source: "mic", chunk: "" });
  await harness.run({
    source: "mic",
    chunk: Buffer.alloc(MAX_AUDIO_CHUNK_BYTES + 1).toString("base64"),
  });

  assert.deepEqual(harness.calls.chunks, []);
  assert.deepEqual(harness.sent, [
    { error: "Invalid message" },
    { error: "Audio chunk too large" },
  ]);
});

test("requires explicit message dependencies", () => {
  assert.throws(() => createMessageHandler(), /ChatHistory and ContextStore are required/);
  assert.throws(
    () => createMessageHandler({ ChatHistory: {}, ContextStore: {} }),
    /generateReply and buildPrompt are required/
  );
});
