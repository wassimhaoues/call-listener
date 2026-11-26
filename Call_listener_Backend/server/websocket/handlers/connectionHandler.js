import { createMessageHandler } from "./messageHandler.js";
import { StreamManager } from "../../services/transcription/streamManager.js";
import { DeepgramService } from "../../services/transcription/deepgramService.js";
import { deepgram } from "../../config/deepgram.js";
import { createChatHistory } from "../../services/chat/chatHistory.js";
import { createContextStore } from "../../services/chat/contextStore.js";
import { createAiReplyGenerator } from "../../services/ai/aiService.js";
import { buildPrompt } from "../../services/ai/promptBuilder.js";
import { redis } from "../../config/redis.js";
import { CONFIG } from "../../config/env.js";
import { parseInterviewContext } from "../../contracts/interviewContext.js";
import { createInterviewWorkflow } from "../../services/interview/interviewWorkflow.js";
import { createInterviewBudget } from "../../services/ai/interviewBudget.js";
import { loggers } from "../../core/logger/index.js";
import { createSessionManager } from "../../services/session/sessionManager.js";
import { createConnectionHandler } from "./connectionLifecycle.js";

const log = loggers.websocket;
const ChatHistory = createChatHistory({ redisClient: redis });
const ContextStore = createContextStore({ redisClient: redis });
const generateReply = createAiReplyGenerator({
  provider: CONFIG.AI_PROVIDER,
  groqApiKey: CONFIG.GROQ_API_KEY,
  groqModel: CONFIG.GROQ_MODEL,
  openRouterApiKey: CONFIG.OPENROUTER_API_KEY,
  openRouterModel: CONFIG.OPENROUTER_MODEL,
  openRouterAllowedModels: CONFIG.OPENROUTER_ALLOWED_MODELS,
  openRouterMaxOutputTokens: CONFIG.OPENROUTER_MAX_OUTPUT_TOKENS,
  openRouterRequestTimeoutMs: CONFIG.OPENROUTER_REQUEST_TIMEOUT_MS,
  log: loggers.ai,
});
const interviewWorkflow = createInterviewWorkflow({ buildPrompt, generateReply });
const Budget = CONFIG.AI_PROVIDER === "openrouter"
  ? createInterviewBudget({
    redisClient: redis,
    maxUsd: CONFIG.MAX_INTERVIEW_COST_USD,
    inputUsdPerMillionTokens: CONFIG.OPENROUTER_INPUT_USD_PER_MILLION_TOKENS,
    outputUsdPerMillionTokens: CONFIG.OPENROUTER_OUTPUT_USD_PER_MILLION_TOKENS,
  })
  : null;
const handleMessage = createMessageHandler({
  ChatHistory,
  ContextStore,
  generateReply,
  buildPrompt,
  parseContext: parseInterviewContext,
  Budget,
  // Model selection is OpenRouter-only; the Groq rollback adapter rejects any explicit choice.
  isModelAllowed: (modelId) => CONFIG.AI_PROVIDER === "openrouter" &&
    CONFIG.OPENROUTER_ALLOWED_MODELS.includes(modelId),
});

const sessions = createSessionManager({
  createStreamManager: (sessionId) => new StreamManager(sessionId, {
    createTranscriptionStream: (label, language) => new DeepgramService(label, {
      deepgramClient: deepgram,
      language,
    }),
    ChatHistory,
    ContextStore,
    generateReply,
    buildPrompt,
    runInterviewWorkflow: async (input) => {
      const result = await interviewWorkflow.invoke(input);
      return result.suggestion;
    },
    Budget,
  }),
  // Same Redis keys and purge as before: chat:<id>, context:<id>, budget.
  purgeSession: async (sessionId) => {
    await ChatHistory.clear(sessionId);
    await ContextStore.clear(sessionId);
    await Budget?.clear(sessionId);
  },
  resumeWindowMs: CONFIG.RESUME_WINDOW_MS,
  log,
});

export const handleConnection = createConnectionHandler({ sessions, handleMessage, log });
