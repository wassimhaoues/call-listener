import { setImmediate as nextTurn } from "node:timers/promises";
import { createMessageHandler } from "../../server/websocket/handlers/messageHandler.js";
import { StreamManager } from "../../server/services/transcription/streamManager.js";
import { DeepgramService } from "../../server/services/transcription/deepgramService.js";
import { createChatHistory } from "../../server/services/chat/chatHistory.js";
import { createContextStore } from "../../server/services/chat/contextStore.js";
import { createAiReplyGenerator } from "../../server/services/ai/aiService.js";
import { createInterviewBudget } from "../../server/services/ai/interviewBudget.js";
import { buildPrompt } from "../../server/services/ai/promptBuilder.js";
import { createInterviewWorkflow } from "../../server/services/interview/interviewWorkflow.js";
import { createDebriefGenerator } from "../../server/services/interview/debrief.js";
import { parseInterviewContext } from "../../server/contracts/interviewContext.js";
import { createMemoryRedis } from "./memoryRedis.js";
import { createFakeDeepgramClient } from "./fakeDeepgram.js";
import { createFakeChatOpenRouter } from "./fakeProvider.js";
import { resolveContextCase, silentPcmChunk } from "./fixtures.js";

const silentLog = { debug() {}, info() {}, warn() {}, error() {} };
// Hang guard only: replays are event-driven and normally settle in a few ms.
const WAIT_GUARD_MS = 5_000;

/**
 * Compose the real message handler, stream manager, Deepgram service, LangGraph
 * workflow, OpenRouter adapter, session stores, and budget the same way
 * `connectionHandler.js` does, with only the network edges (Deepgram socket,
 * provider client, Redis, WebSocket client) replaced by fakes.
 */
export function createReplayHarness({
  responses,
  contexts,
  providerScript = [],
  maxUsd = 5,
  inputUsdPerMillionTokens = 0.2,
  outputUsdPerMillionTokens = 1.2,
  requestTimeoutMs = 10_000,
  // Replays flush streamed deltas only on completion so they stay timer-free
  // and deterministic; time-based batching is covered by unit tests.
  streamFlushMs = 60_000,
  actionMinIntervalMs = 0,
  // Interim frames are sent on every update so replays stay timer-free;
  // the 200 ms throttle has unit tests.
  interimIntervalMs = 0,
  sessionId = "replay-session",
} = {}) {
  const redis = createMemoryRedis();
  const ChatHistory = createChatHistory({ redisClient: redis, log: silentLog });
  const ContextStore = createContextStore({ redisClient: redis, log: silentLog });
  const realBudget = createInterviewBudget({
    redisClient: redis,
    maxUsd,
    inputUsdPerMillionTokens,
    outputUsdPerMillionTokens,
    log: silentLog,
  });
  const usageCalls = [];
  const estimatedUsage = [];
  const Budget = {
    ...realBudget,
    async recordUsage(id, usage, estimateBasis) {
      usageCalls.push(usage ?? null);
      const result = await realBudget.recordUsage(id, usage, estimateBasis);
      if (result.estimated) estimatedUsage.push(result);
      return result;
    },
  };

  const provider = createFakeChatOpenRouter({ responses, script: providerScript });
  const generateReply = createAiReplyGenerator({
    provider: "openrouter",
    openRouterApiKey: "fixture-key-not-a-secret",
    openRouterModel: "fixture/model",
    openRouterMaxOutputTokens: 600,
    openRouterRequestTimeoutMs: requestTimeoutMs,
    log: silentLog,
    dependencies: { openrouter: { ChatOpenRouterClass: provider.ChatOpenRouterClass } },
  });
  const workflow = createInterviewWorkflow({ buildPrompt, generateReply });

  const deepgram = createFakeDeepgramClient();
  const services = {};
  const streamManager = new StreamManager(sessionId, {
    createTranscriptionStream: (label, language) => {
      const service = new DeepgramService(label, { deepgramClient: deepgram, language, log: silentLog });
      services[label] = service;
      return service;
    },
    ChatHistory,
    ContextStore,
    generateReply,
    buildPrompt,
    runInterviewWorkflow: async (input) => (await workflow.invoke(input)).suggestion,
    Budget,
    log: silentLog,
    interimIntervalMs,
  });
  // The production 800 ms cooldown only delays the next generation; replays
  // assert ordering, so it is disabled to keep them fast and timer-free.
  streamManager.REPLY_COOLDOWN_MS = 0;
  streamManager.STREAM_FLUSH_MS = streamFlushMs;
  // Likewise for the response-action interval; rate limits have unit tests.
  streamManager.ACTION_MIN_INTERVAL_MS = actionMinIntervalMs;

  const generateDebrief = createDebriefGenerator({
    ChatHistory,
    ContextStore,
    generateReply,
    Budget,
    log: silentLog,
  });
  const handleMessage = createMessageHandler({
    ChatHistory,
    ContextStore,
    generateReply,
    buildPrompt,
    parseContext: parseInterviewContext,
    generateDebrief,
    Budget,
    log: silentLog,
  });

  const outbound = [];
  const wsClient = {
    OPEN: 1,
    readyState: 1,
    send: (payload) => outbound.push(JSON.parse(payload)),
  };

  function sendRaw(data) {
    return handleMessage({ wsClient, sessionId, data: Buffer.from(data), streamManager });
  }

  async function waitUntil(predicate, description) {
    const startedAt = Date.now();
    while (!predicate()) {
      if (Date.now() - startedAt > WAIT_GUARD_MS) {
        throw new Error(
          `Replay stalled waiting for ${description}; outbound so far: ${JSON.stringify(outbound)}`
        );
      }
      await nextTurn();
    }
  }

  const isIdle = () =>
    !streamManager.pendingQuestion &&
    !streamManager.replyTimer &&
    (!streamManager.isResponding || provider.pendingCount() > 0);

  /** Wait for the scheduler to go idle, then flush a few more turns for stragglers. */
  async function settle() {
    await waitUntil(isIdle, "the session to go idle");
    for (let turn = 0; turn < 5; turn += 1) await nextTurn();
    await waitUntil(isIdle, "the session to go idle");
  }

  function connection(source) {
    const conn = services[source]?.conn;
    if (!conn) throw new Error(`No ${source} transcription stream exists yet; send audio first`);
    return conn;
  }

  /** Execute one scripted session step (see test/fixtures/sessions/*.json). */
  async function runStep(step) {
    const before = provider.calls.length;
    switch (step.type) {
      case "context": {
        const context = resolveContextCase(contexts, { base: step.context });
        // `capabilities` is advertised at the context top level, as the desktop client does.
        await sendRaw(JSON.stringify({
          context: step.capabilities ? { ...context, capabilities: step.capabilities } : context,
        }));
        break;
      }
      case "audio":
        for (let index = 0; index < (step.count ?? 1); index += 1) {
          await sendRaw(JSON.stringify({ source: step.source, chunk: silentPcmChunk(step.bytes) }));
        }
        break;
      case "transcript":
        connection(step.source).emitTranscript(step.text, { isFinal: step.isFinal });
        break;
      case "utteranceEnd":
        connection(step.source).emitUtteranceEnd();
        break;
      case "typed":
        await sendRaw(JSON.stringify({ interviewer_question: step.text }));
        break;
      case "action":
        await sendRaw(JSON.stringify({ action: { type: step.action, generationId: step.generationId } }));
        break;
      case "raw":
        await sendRaw(step.data);
        break;
      case "end":
        // `debrief: true` ends the way "Stop and review" does.
        await sendRaw(JSON.stringify({ end: step.debrief ? { debrief: true } : true }));
        break;
      default:
        throw new Error(`Unknown replay step type: ${step.type}`);
    }
    if (step.waitFor === "providerPending") {
      await waitUntil(
        () => provider.calls.length > before && provider.pendingCount() > 0,
        `a pending provider call (${step.label || step.type})`
      );
    }
    if (step.waitFor === "providerStreamed") {
      // Every scripted chunk was yielded and the stream is still open.
      await waitUntil(() => {
        const call = provider.calls[before];
        const chunks = call && responses[call.name]?.chunks;
        return call?.status === "pending" && chunks && call.chunksYielded === chunks.length;
      }, `a streamed provider call held open (${step.label || step.type})`);
      for (let turn = 0; turn < 5; turn += 1) await nextTurn();
    }
  }

  return {
    outbound,
    provider,
    deepgram,
    services,
    redis,
    streamManager,
    ChatHistory,
    ContextStore,
    Budget,
    usageCalls,
    estimatedUsage,
    sessionId,
    sendRaw,
    send: (message) => sendRaw(JSON.stringify(message)),
    runStep,
    waitUntil,
    settle,
    waitForOutbound: (count, description = `${count} outbound messages`) =>
      waitUntil(() => outbound.length >= count, description),
  };
}
