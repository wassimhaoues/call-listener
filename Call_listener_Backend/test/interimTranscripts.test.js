import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  boundInterimText,
  createInterimThrottle,
  INTERIM_MIN_INTERVAL_MS,
  MAX_INTERIM_CHARS,
} from "../server/services/transcription/interimTranscripts.js";
import { DeepgramService } from "../server/services/transcription/deepgramService.js";
import { StreamManager } from "../server/services/transcription/streamManager.js";
import { SessionChannel } from "../server/services/session/sessionChannel.js";
import { createFakeDeepgramClient } from "./helpers/fakeDeepgram.js";

const silentLog = { info() {}, debug() {}, warn() {}, error() {} };

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Manual clock and timers for the throttle. */
function createFakeTimers() {
  let current = 1_000;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => current,
    setTimer(callback, ms) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { callback, at: current + ms });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    advance(ms) {
      current += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= current) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
    get pending() {
      return timers.size;
    },
  };
}

test("bounds interim text to the newest MAX_INTERIM_CHARS characters", () => {
  assert.equal(boundInterimText("  hello  "), "hello");
  assert.equal(boundInterimText(undefined), "");
  const long = `${"a".repeat(MAX_INTERIM_CHARS)} tail words`;
  const bounded = boundInterimText(long);
  assert.ok(bounded.length <= MAX_INTERIM_CHARS);
  assert.ok(bounded.endsWith("tail words"));
});

test("throttles interim lines to one per interval per source, keeping the newest text", () => {
  const timers = createFakeTimers();
  const sent = [];
  const throttle = createInterimThrottle({
    send: (label, text) => sent.push([label, text]),
    now: timers.now,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  throttle.push("system", "Tell");
  throttle.push("system", "Tell me");
  throttle.push("system", "Tell me about");
  throttle.push("mic", "Mm");
  assert.deepEqual(sent, [["system", "Tell"], ["mic", "Mm"]], "leading edge per source");

  timers.advance(INTERIM_MIN_INTERVAL_MS - 1);
  assert.equal(sent.length, 2);
  timers.advance(1);
  assert.deepEqual(sent.at(-1), ["system", "Tell me about"], "trailing edge sends only the newest text");

  // 50 updates over one second never exceed five frames for the source.
  sent.length = 0;
  for (let index = 0; index < 50; index += 1) {
    throttle.push("system", `word ${index}`);
    timers.advance(20);
  }
  timers.advance(INTERIM_MIN_INTERVAL_MS);
  const systemFrames = sent.filter(([label]) => label === "system");
  assert.ok(systemFrames.length <= 6, `sent ${systemFrames.length} frames in ~1.2 s`);
  assert.deepEqual(systemFrames.at(-1), ["system", "word 49"]);
});

test("does not resend unchanged text and settle drops pending text", () => {
  const timers = createFakeTimers();
  const sent = [];
  const throttle = createInterimThrottle({
    send: (label, text) => sent.push([label, text]),
    now: timers.now,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  throttle.push("system", "Same");
  timers.advance(INTERIM_MIN_INTERVAL_MS);
  throttle.push("system", "Same");
  assert.deepEqual(sent, [["system", "Same"]]);

  throttle.push("system", "Pending");
  throttle.push("system", "Pending text");
  timers.advance(INTERIM_MIN_INTERVAL_MS - 1);
  sent.length = 0;
  throttle.push("system", "Pending more");
  assert.equal(throttle.settle("system"), true, "an interim line had been shown");
  timers.advance(INTERIM_MIN_INTERVAL_MS);
  assert.deepEqual(sent, [], "nothing is sent for a settled line");
  assert.equal(timers.pending, 0);
  assert.equal(throttle.settle("system"), false, "nothing shown since the last settle");
  assert.equal(throttle.settle("mic"), false, "unknown source");

  throttle.push("mic", "Later");
  throttle.push("mic", "Later still");
  throttle.cancelAll();
  timers.advance(INTERIM_MIN_INTERVAL_MS);
  assert.deepEqual(sent, [["mic", "Later"]]);
});

test("DeepgramService emits interim lines with finalized segments and ends abandoned ones", async () => {
  const deepgram = createFakeDeepgramClient();
  const service = new DeepgramService("system", { deepgramClient: deepgram, language: "en", log: silentLog });
  const events = [];
  service.on("interim", ({ label, text }) => events.push(["interim", label, text]));
  service.on("utterance", ({ label, text }) => events.push(["utterance", label, text]));
  await service.start();
  const [conn] = deepgram.connections;

  conn.emitTranscript("Tell me", { isFinal: false });
  conn.emitTranscript("Tell me about it.", { isFinal: true });
  conn.emitTranscript("Why", { isFinal: false });
  conn.emitTranscript("", { isFinal: false });
  conn.emitUtteranceEnd();
  conn.emitTranscript("Uh", { isFinal: false });
  conn.emitUtteranceEnd();
  conn.emitUtteranceEnd();

  assert.deepEqual(events, [
    ["interim", "system", "Tell me"],
    ["interim", "system", "Tell me about it."],
    ["interim", "system", "Tell me about it. Why"],
    ["utterance", "system", "Tell me about it."],
    ["interim", "system", "Uh"],
    ["interim", "system", ""],
  ]);
});

class FakeStream extends EventEmitter {
  async start() {}
  sendChunk() {}
  async stop() {}
}

function createManager({ interimIntervalMs = 0 } = {}) {
  const streams = [];
  const history = [];
  const prompts = [];
  const manager = new StreamManager("session-1", {
    createTranscriptionStream: () => {
      const stream = new FakeStream();
      streams.push(stream);
      return stream;
    },
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
  const sent = [];
  const wsClient = { OPEN: 1, readyState: 1, send: (payload) => sent.push(JSON.parse(payload)) };
  return { manager, streams, history, prompts, sent, wsClient };
}

async function startCapture(manager, wsClient, label = "system") {
  await manager.sendChunk(label, Buffer.from([1]));
  await manager.ensureListeners(wsClient);
}

test("interim lines reach only interim-capable clients and are never stored or classified", async () => {
  const { manager, streams, history, prompts, sent, wsClient } = createManager();
  await startCapture(manager, wsClient);

  streams[0].emit("interim", { label: "system", text: "Tell me about a migration?" });
  assert.deepEqual(sent, [], "no interim frames without the capability");

  manager.setClientCapabilities({ interim: true });
  streams[0].emit("interim", { label: "system", text: "Tell me about a migration?" });
  await nextTick();
  assert.deepEqual(sent, [{ interim: { speaker: "caller", text: "Tell me about a migration?" } }]);
  assert.deepEqual(history, [], "interim text never joins chat history");
  assert.deepEqual(prompts, [], "interim text never starts a generation");
  assert.equal(manager.pendingQuestion, null);

  await startCapture(manager, wsClient, "mic");
  streams[1].emit("interim", { label: "mic", text: "Mm" });
  assert.deepEqual(sent.at(-1), { interim: { speaker: "you", text: "Mm" } });

  manager.setClientCapabilities({ stream: true });
  streams[1].emit("interim", { label: "mic", text: "Mm hmm" });
  assert.equal(sent.length, 2, "a context without interim downgrades the session");
});

test("a pending interim line is dropped when its final transcript arrives", async () => {
  const { manager, streams, sent, wsClient } = createManager({ interimIntervalMs: 60_000 });
  manager.setClientCapabilities({ interim: true });
  await startCapture(manager, wsClient);

  streams[0].emit("interim", { label: "system", text: "Hello" });
  streams[0].emit("interim", { label: "system", text: "Hello there" });
  streams[0].emit("utterance", { label: "system", text: "Hello there." });
  await nextTick();
  assert.deepEqual(sent, [
    { interim: { speaker: "caller", text: "Hello" } },
    { speaker: "caller", transcript: "Hello there." },
  ]);
  assert.equal(manager.interimThrottle.settle("system"), false, "the final ended the line");
});

for (const stop of ["pause", "closeAll"]) {
  test(`no interim frames are sent after ${stop}`, async () => {
    const { manager, streams, sent, wsClient } = createManager({ interimIntervalMs: 60_000 });
    manager.setClientCapabilities({ interim: true });
    await startCapture(manager, wsClient);
    const [stream] = streams;

    stream.emit("interim", { label: "system", text: "First" });
    stream.emit("interim", { label: "system", text: "First and pending" });
    await manager[stop]();
    stream.emit("interim", { label: "system", text: "After stop" });
    manager.handleInterim("system", "Direct after stop");
    assert.deepEqual(sent, [{ interim: { speaker: "caller", text: "First" } }]);
    assert.equal(stream.listenerCount("interim"), 0, "interim listener detached");
  });
}

test("interim frames are sequenced but never replayed on resume", () => {
  const channel = new SessionChannel();
  const socket = { OPEN: 1, readyState: 1, sent: [], send(data) { this.sent.push(JSON.parse(data)); } };
  channel.attach(socket);
  channel.enableSequencing();
  channel.send(JSON.stringify({ interim: { speaker: "caller", text: "Tell me" } }));
  channel.send(JSON.stringify({ speaker: "caller", transcript: "Tell me more." }));
  channel.send(JSON.stringify({ interim: { speaker: "caller", text: "" } }));

  assert.deepEqual(socket.sent.map((message) => message.seq), [1, 2, 3]);
  socket.sent.length = 0;
  channel.replaySince(0);
  assert.deepEqual(socket.sent, [{ speaker: "caller", transcript: "Tell me more.", seq: 2 }]);
});
