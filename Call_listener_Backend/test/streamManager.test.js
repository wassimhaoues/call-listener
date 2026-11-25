import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { StreamManager } from "../server/services/transcription/streamManager.js";

class FakeStream extends EventEmitter {
  constructor() {
    super();
    this.startCalls = 0;
    this.stopCalls = 0;
    this.chunks = [];
  }

  async start() {
    this.startCalls += 1;
  }

  sendChunk(chunk) {
    this.chunks.push(chunk);
  }

  async stop() {
    this.stopCalls += 1;
  }
}

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createManager({ generateReply = async () => "A concise answer." } = {}) {
  const streams = [];
  const history = [];
  const manager = new StreamManager("session-1", {
    createTranscriptionStream: () => {
      const stream = new FakeStream();
      streams.push(stream);
      return stream;
    },
    ChatHistory: {
      push: async (...entry) => history.push(entry),
      toPrompt: async () => "caller: Tell me about a migration.",
    },
    ContextStore: { get: async () => ({ candidate: "Ada" }) },
    generateReply,
    buildPrompt: () => "reply prompt",
    log: { info() {}, debug() {}, warn() {}, error() {} },
  });
  return { manager, streams, history };
}

test("creates only one stream when same-source audio arrives concurrently", async () => {
  const { manager, streams } = createManager();

  const results = await Promise.all([
    manager.sendChunk("mic", Buffer.from([1])),
    manager.sendChunk("mic", Buffer.from([2])),
  ]);

  assert.deepEqual(results, [true, true]);
  assert.equal(streams.length, 1);
  assert.equal(streams[0].startCalls, 1);
  assert.deepEqual(streams[0].chunks.map((chunk) => [...chunk]), [[1], [2]]);
});

test("stops streams once and suppresses a model reply that completes after close", async () => {
  let resolveReply;
  let generationSignal;
  const pendingReply = new Promise((resolve) => { resolveReply = resolve; });
  const { manager, streams, history } = createManager({
    generateReply: async (_prompt, _history, { signal }) => {
      generationSignal = signal;
      return pendingReply;
    },
  });
  const sent = [];
  const wsClient = {
    OPEN: 1,
    readyState: 1,
    send: (payload) => sent.push(JSON.parse(payload)),
  };

  await manager.sendChunk("system", Buffer.from([1]));
  await manager.ensureListeners(wsClient);
  streams[0].emit("utterance", {
    label: "system",
    text: "Tell me about a migration.",
  });
  await nextTick();

  await Promise.all([manager.closeAll(), manager.closeAll()]);
  assert.equal(generationSignal.aborted, true);
  resolveReply("This reply must not be sent after Stop.");
  await nextTick();

  assert.equal(streams[0].stopCalls, 1);
  assert.equal(await manager.sendChunk("system", Buffer.from([2])), false);
  assert.equal(sent.some((message) => message.ai_reply), false);
  assert.equal(history.some((entry) => entry[1] === "assistant"), false);
  assert.equal(manager.summarize().closed, true);
});

test("keeps acknowledgements in history without generating a suggestion", async () => {
  let replyCalls = 0;
  const { manager, streams, history } = createManager({
    generateReply: async () => { replyCalls += 1; return "unused"; },
  });
  const wsClient = { OPEN: 1, readyState: 1, send() {} };
  await manager.sendChunk("system", Buffer.from([1]));
  await manager.ensureListeners(wsClient);
  streams[0].emit("utterance", { label: "system", text: "Thanks, that is helpful." });
  await nextTick();

  assert.equal(replyCalls, 0);
  assert.deepEqual(history[0].slice(1), ["caller", "Thanks, that is helpful."]);
});

test("runs a typed interviewer question through the same transcript and guidance path", async () => {
  const { manager, history } = createManager();
  manager.REPLY_COOLDOWN_MS = 0;
  const sent = [];
  const wsClient = {
    OPEN: 1,
    readyState: 1,
    send: (payload) => sent.push(JSON.parse(payload)),
  };

  await manager.submitInterviewerQuestion("How did you lead the migration?", wsClient);
  await nextTick();
  await nextTick();

  assert.deepEqual(history[0].slice(1), ["caller", "How did you lead the migration?"]);
  assert.deepEqual(sent.filter((message) => message.speaker), [
    { speaker: "caller", transcript: "How did you lead the migration?" },
  ]);
  assert.deepEqual(sent.filter((message) => message.ai_reply), [
    { ai_reply: "A concise answer." },
  ]);
});

test("the default workflow forwards provider usage to the interview budget", async () => {
  const recorded = [];
  const manager = new StreamManager("session-1", {
    createTranscriptionStream: () => new FakeStream(),
    ChatHistory: { push: async () => {}, toPrompt: async () => "" },
    ContextStore: { get: async () => null },
    generateReply: async (_prompt, _history, { onUsage }) => {
      await onUsage?.({ input_tokens: 10, output_tokens: 2 });
      return "A concise answer.";
    },
    buildPrompt: () => "reply prompt",
    Budget: {
      canGenerate: async () => ({ allowed: true }),
      recordUsage: async (sessionId, usage) => recorded.push([sessionId, usage]),
    },
    log: { info() {}, debug() {}, warn() {}, error() {} },
  });
  manager.REPLY_COOLDOWN_MS = 0;

  await manager.submitInterviewerQuestion("How did you lead the migration?", { OPEN: 1, readyState: 1, send() {} });
  await nextTick();
  await nextTick();

  assert.deepEqual(recorded, [["session-1", { input_tokens: 10, output_tokens: 2 }]]);
});

test("reports a terminal generation failure instead of leaving a question pending", async () => {
  const { manager } = createManager({
    generateReply: async () => {
      throw new Error("provider unavailable");
    },
  });
  manager.REPLY_COOLDOWN_MS = 0;
  const sent = [];
  const wsClient = {
    OPEN: 1,
    readyState: 1,
    send: (payload) => sent.push(JSON.parse(payload)),
  };

  await manager.submitInterviewerQuestion("How did you lead the migration?", wsClient);
  await nextTick();
  await nextTick();

  assert.deepEqual(sent.filter((message) => message.generation), [
    { generation: { state: "thinking" } },
    { generation: { state: "failed" }, ai_reply: "[Erreur du modèle]" },
  ]);
});

test("supersedes an in-flight reply when a newer interviewer question arrives", async () => {
  const resolvers = [];
  const { manager, streams } = createManager({
    generateReply: async () => new Promise((resolve) => resolvers.push(resolve)),
  });
  manager.REPLY_COOLDOWN_MS = 0;
  const sent = [];
  const wsClient = {
    OPEN: 1,
    readyState: 1,
    send: (payload) => sent.push(JSON.parse(payload)),
  };
  await manager.sendChunk("system", Buffer.from([1]));
  await manager.ensureListeners(wsClient);
  streams[0].emit("utterance", { label: "system", text: "Tell me about Redis." });
  await nextTick();
  streams[0].emit("utterance", { label: "system", text: "How did you handle failures?" });
  await nextTick();

  resolvers[0]("stale reply");
  await nextTick();
  await nextTick();
  assert.equal(resolvers.length, 2);
  resolvers[1]("latest reply");
  await nextTick();

  assert.deepEqual(sent.filter((message) => message.ai_reply), [{ ai_reply: "latest reply" }]);
});

test("requires explicit provider and storage dependencies", () => {
  assert.throws(() => new StreamManager("session-1"), /createTranscriptionStream is required/);
  assert.throws(
    () => new StreamManager("session-1", { createTranscriptionStream: () => ({}) }),
    /ChatHistory and ContextStore are required/
  );
});
