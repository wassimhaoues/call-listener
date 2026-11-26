import { EventEmitter } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createMessageHandler } from "../../server/websocket/handlers/messageHandler.js";
import { createConnectionHandler } from "../../server/websocket/handlers/connectionLifecycle.js";
import { createSessionManager } from "../../server/services/session/sessionManager.js";
import { StreamManager } from "../../server/services/transcription/streamManager.js";
import { DeepgramService } from "../../server/services/transcription/deepgramService.js";
import { createChatHistory } from "../../server/services/chat/chatHistory.js";
import { createContextStore } from "../../server/services/chat/contextStore.js";
import { parseInterviewContext } from "../../server/contracts/interviewContext.js";
import { createMemoryRedis } from "./memoryRedis.js";
import { createFakeDeepgramClient } from "./fakeDeepgram.js";

export const silentLog = { debug() {}, info() {}, warn() {}, error() {} };
const WAIT_GUARD_MS = 5_000;

export const OWNER = Object.freeze({ app_id: "com.coworky.calllistener", device_id: "device-a" });
export const OTHER_OWNER = Object.freeze({ app_id: "com.coworky.calllistener", device_id: "device-b" });

export const CANDIDATE_CONTEXT = Object.freeze({
  version: 1,
  candidate: { name: "Ada" },
  jobOffer: { title: "Backend engineer" },
  settings: { language: "en" },
});

/**
 * Model double: every call stays pending until the test settles it, and an
 * abort rejects it. `buildPrompt` returns the prompt kind, so `call.kind` is
 * "intro" or "reply".
 */
export function createControlledGenerator() {
  const calls = [];
  async function generateReply(kind, history, { signal } = {}) {
    return new Promise((resolve, reject) => {
      const call = { kind, history, status: "pending" };
      call.resolve = (text) => {
        if (call.status !== "pending") return;
        call.status = "resolved";
        resolve(text);
      };
      calls.push(call);
      signal?.addEventListener("abort", () => {
        if (call.status !== "pending") return;
        call.status = "aborted";
        reject(signal.reason);
      }, { once: true });
    });
  }
  return {
    calls,
    generateReply,
    pending: () => calls.filter((call) => call.status === "pending"),
  };
}

/** Let `count` event-loop turns run, one after another. */
export function flushTurns(count) {
  return Array.from({ length: count }).reduce((previous) => previous.then(() => nextTurn()), Promise.resolve());
}

/** Poll `predicate` once per event-loop turn, failing after a hang guard. */
export async function waitUntil(predicate, description, startedAt = Date.now()) {
  if (predicate()) return;
  if (Date.now() - startedAt > WAIT_GUARD_MS) throw new Error(`Timed out waiting for ${description}`);
  await nextTurn();
  return waitUntil(predicate, description, startedAt);
}

const settle = () => flushTurns(10);

/** Manually fired replacement for setTimeout/clearTimeout. */
export function createManualTimers() {
  const scheduled = [];
  return {
    scheduled,
    setTimeout(fn, ms) {
      const timer = { fn, ms, cleared: false, fired: false };
      scheduled.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
    active: () => scheduled.filter((timer) => !timer.cleared && !timer.fired),
    async fireAll() {
      for (const timer of scheduled.filter((t) => !t.cleared && !t.fired)) {
        timer.fired = true;
        timer.fn();
      }
      await flushTurns(10);
    },
  };
}

/** Server-side `ws` socket double driven directly by tests. */
export class FakeServerSocket extends EventEmitter {
  constructor(user = OWNER) {
    super();
    this.OPEN = 1;
    this.readyState = 1;
    this.user = { ...user };
    this.raw = [];
    this.closed = null;
  }

  send(data) {
    this.raw.push(data);
  }

  get outbound() {
    return this.raw.map((data) => JSON.parse(data));
  }

  close(code, reason) {
    this.readyState = 3;
    this.closed = { code, reason };
  }

  /** Deliver one client frame and wait for the async handler to finish. */
  async receive(message) {
    const data = Buffer.from(typeof message === "string" ? message : JSON.stringify(message));
    await Promise.all(this.listeners("message").map((listener) => listener(data)));
  }

  /** Simulate the transport dropping, then run the server close handler. */
  async drop() {
    this.readyState = 3;
    await Promise.all(this.listeners("close").map((listener) => listener()));
  }
}

/**
 * Compose the real connection lifecycle, session manager, message handler,
 * stream manager, Deepgram service, and Redis-backed stores the way
 * `connectionHandler.js` does. Only the network edges are fakes.
 */
export function createSessionHarness({ resumeWindowMs = 120_000, replayLimits, generateDebrief } = {}) {
  const redis = createMemoryRedis();
  const ChatHistory = createChatHistory({ redisClient: redis, log: silentLog });
  const ContextStore = createContextStore({ redisClient: redis, log: silentLog });
  const generator = createControlledGenerator();
  const buildPrompt = (_context, kind) => kind;
  const deepgram = createFakeDeepgramClient();
  const timers = createManualTimers();
  const purged = [];

  const sessions = createSessionManager({
    createStreamManager: (sessionId) => {
      const manager = new StreamManager(sessionId, {
        createTranscriptionStream: (label, language) =>
          new DeepgramService(label, { deepgramClient: deepgram, language, log: silentLog }),
        ChatHistory,
        ContextStore,
        generateReply: generator.generateReply,
        buildPrompt,
        log: silentLog,
      });
      manager.REPLY_COOLDOWN_MS = 0;
      return manager;
    },
    purgeSession: async (sessionId) => {
      purged.push(sessionId);
      await ChatHistory.clear(sessionId);
      await ContextStore.clear(sessionId);
    },
    resumeWindowMs,
    replayLimits,
    timers,
    log: silentLog,
  });
  const handleMessage = createMessageHandler({
    ChatHistory,
    ContextStore,
    generateReply: generator.generateReply,
    buildPrompt,
    parseContext: parseInterviewContext,
    generateDebrief,
    log: silentLog,
  });
  const handleConnection = createConnectionHandler({ sessions, handleMessage, log: silentLog });

  function connect(user = OWNER) {
    const socket = new FakeServerSocket(user);
    handleConnection(socket);
    return socket;
  }

  /**
   * Send a context and answer its intro call with `introText`. Resolves once
   * the handler finished with the context frame.
   */
  async function sendContext(socket, { capabilities = ["resume"], introText = "Intro." } = {}) {
    const before = generator.calls.length;
    const sending = socket.receive({ context: { ...CANDIDATE_CONTEXT, capabilities } });
    await waitUntil(() => generator.calls.length > before, "the intro call");
    generator.calls[before].resolve(introText);
    await sending;
  }

  /** Send a typed interviewer question; resolves when its reply call is pending. */
  async function ask(socket, question) {
    const before = generator.calls.length;
    await socket.receive({ interviewer_question: question });
    await waitUntil(() => generator.calls.length > before, "the reply call");
    return generator.calls[before];
  }

  return {
    redis,
    ChatHistory,
    ContextStore,
    generator,
    deepgram,
    timers,
    purged,
    sessions,
    handleConnection,
    connect,
    waitUntil,
    settle,
    sendContext,
    ask,
    contextKey: (sessionId) => `context:${sessionId}`,
  };
}
