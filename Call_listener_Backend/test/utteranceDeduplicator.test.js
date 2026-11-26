import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  createUtteranceDeduplicator,
  isNearDuplicate,
  normalizeUtterance,
  UTTERANCE_DEDUP_WINDOW_MS,
} from "../server/services/transcription/utteranceDeduplicator.js";
import { StreamManager } from "../server/services/transcription/streamManager.js";
import { DeepgramService } from "../server/services/transcription/deepgramService.js";
import { createFakeDeepgramClient } from "./helpers/fakeDeepgram.js";

const silentLog = { info() {}, debug() {}, warn() {}, error() {} };

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("normalizes case, punctuation, and whitespace", () => {
  assert.equal(normalizeUtterance("  Tell me, about   a TIME!  "), "tell me about a time");
  assert.equal(normalizeUtterance("Qu'avez-vous appris ?"), "qu avez vous appris");
  assert.equal(normalizeUtterance(null), "");
});

test("near-exact duplicates are the same text or a repeated tail of at least three words", () => {
  assert.equal(isNearDuplicate("tell me about it", "tell me about it"), true);
  assert.equal(isNearDuplicate("tell me about a time you led a migration", "you led a migration"), true);
  assert.equal(isNearDuplicate("tell me why you did that", "why"), false, "short follow-ups are kept");
  assert.equal(isNearDuplicate("tell me why you did that", "that"), false);
  assert.equal(isNearDuplicate("tell me about it", "tell me about it and more"), false, "new content is kept");
  assert.equal(isNearDuplicate("", ""), false);
});

test("suppresses repeats per source only within the window", () => {
  let now = 10_000;
  const dedup = createUtteranceDeduplicator({ now: () => now });

  assert.equal(dedup.isDuplicate("system", "Tell me about a migration."), false);
  now += 500;
  assert.equal(dedup.isDuplicate("system", "tell me about a migration"), true);
  assert.equal(dedup.isDuplicate("mic", "Tell me about a migration."), false, "sources are independent");
  now += UTTERANCE_DEDUP_WINDOW_MS;
  assert.equal(dedup.isDuplicate("system", "Tell me about a migration."), true, "a repeat extends the window");
  now += UTTERANCE_DEDUP_WINDOW_MS + 1;
  assert.equal(dedup.isDuplicate("system", "Tell me about a migration."), false, "outside the window");
  assert.equal(dedup.isDuplicate("system", "Why?"), false);
  assert.equal(dedup.isDuplicate("system", "Tell me about a migration."), false, "only the latest utterance counts");
  dedup.reset();
  assert.equal(dedup.isDuplicate("system", "Tell me about a migration."), false);
});

class FakeStream extends EventEmitter {
  async start() {}
  sendChunk() {}
  async stop() {}
}

function createManager({ createTranscriptionStream, interimIntervalMs } = {}) {
  const history = [];
  const prompts = [];
  const manager = new StreamManager("session-1", {
    createTranscriptionStream: createTranscriptionStream ?? (() => new FakeStream()),
    ChatHistory: {
      push: async (...entry) => history.push(entry),
      toPrompt: async () => "",
    },
    ContextStore: { get: async () => ({}) },
    generateReply: async (prompt) => {
      prompts.push(prompt);
      return "An answer.";
    },
    buildPrompt: () => "reply prompt",
    log: silentLog,
    interimIntervalMs,
  });
  manager.REPLY_COOLDOWN_MS = 0;
  let now = 50_000;
  manager.now = () => now;
  const sent = [];
  const wsClient = { OPEN: 1, readyState: 1, send: (payload) => sent.push(JSON.parse(payload)) };
  return { manager, history, prompts, sent, wsClient, advance: (ms) => { now += ms; } };
}

async function settle() {
  for (let turn = 0; turn < 10; turn += 1) await nextTick();
}

test("a duplicate interviewer final never runs the classifier or generation twice", async () => {
  const { manager, history, prompts, sent, wsClient, advance } = createManager();
  await manager.sendChunk("system", Buffer.from([1]));
  await manager.ensureListeners(wsClient);
  const stream = manager.streams.system;

  stream.emit("utterance", { label: "system", text: "How did you keep the cutover safe?" });
  await settle();
  advance(800);
  stream.emit("utterance", { label: "system", text: "How did you keep the cutover safe?" });
  await settle();
  stream.emit("utterance", { label: "system", text: "keep the cutover safe" });
  await settle();

  assert.equal(prompts.length, 1, "one generation for one question");
  assert.deepEqual(history, [
    ["session-1", "caller", "How did you keep the cutover safe?"],
    ["session-1", "assistant", "An answer."],
  ]);
  assert.deepEqual(sent, [
    { speaker: "caller", transcript: "How did you keep the cutover safe?" },
    { generation: { state: "thinking" } },
    { ai_reply: "An answer." },
  ]);

  advance(UTTERANCE_DEDUP_WINDOW_MS + 1);
  stream.emit("utterance", { label: "system", text: "How did you keep the cutover safe?" });
  await settle();
  assert.equal(prompts.length, 2, "the interviewer may repeat the question later");
});

test("typed interviewer questions are never deduplicated", async () => {
  const { manager, prompts, wsClient } = createManager();
  await manager.submitInterviewerQuestion("Why this role?", wsClient);
  await settle();
  await manager.submitInterviewerQuestion("Why this role?", wsClient);
  await settle();
  assert.equal(prompts.length, 2);
});

test("duplicate Deepgram finals around an utterance boundary produce one transcript", async () => {
  const deepgram = createFakeDeepgramClient();
  const { manager, prompts, sent, wsClient } = createManager({
    interimIntervalMs: 0,
    createTranscriptionStream: (label, language) =>
      new DeepgramService(label, { deepgramClient: deepgram, language, log: silentLog }),
  });
  manager.setClientCapabilities({ interim: true });
  await manager.sendChunk("system", Buffer.from([1]));
  await manager.ensureListeners(wsClient);
  const [conn] = deepgram.connections;

  conn.emitTranscript("Tell me about a time you led a migration.", { isFinal: true });
  conn.emitUtteranceEnd();
  await settle();
  // The same final flushed again after the boundary.
  conn.emitTranscript("Tell me about a time you led a migration.", { isFinal: true });
  conn.emitUtteranceEnd();
  await settle();

  assert.equal(prompts.length, 1);
  assert.deepEqual(sent.filter((message) => "transcript" in message), [
    { speaker: "caller", transcript: "Tell me about a time you led a migration." },
  ]);
  assert.deepEqual(
    sent.filter((message) => "interim" in message).at(-1),
    { interim: { speaker: "caller", text: "" } },
    "the duplicate's interim line is cleared"
  );
});
