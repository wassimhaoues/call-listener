import { createOpenRouterReplyGenerator } from "../ai/openRouterService.js";
import { createPreparationBriefService } from "./preparationBrief.js";
import { createPreparationLimits } from "./preparationLimits.js";

/**
 * Wire the model-backed preparation brief from deployment configuration.
 *
 * Returns null in `AI_PROVIDER=groq` mode: the Groq rollback adapter cannot
 * cap output tokens, report usage, or honour an allowlisted model choice, so
 * the route answers 501 `preparation_unavailable` instead of spending
 * unmetered requests. The candidate keeps the local brief.
 */
export function createConfiguredPreparationBrief({ config, redisClient, log, ChatOpenRouterClass } = {}) {
  if (!config || config.AI_PROVIDER !== "openrouter") return null;
  const allowed = new Set(config.OPENROUTER_ALLOWED_MODELS || []);
  const generateReply = createOpenRouterReplyGenerator({
    apiKey: config.OPENROUTER_API_KEY,
    model: config.OPENROUTER_MODEL,
    allowedModels: config.OPENROUTER_ALLOWED_MODELS,
    maxOutputTokens: config.PREPARATION_MAX_OUTPUT_TOKENS,
    requestTimeoutMs: config.PREPARATION_REQUEST_TIMEOUT_MS,
    log,
    ...(ChatOpenRouterClass ? { ChatOpenRouterClass } : {}),
  });
  const limits = createPreparationLimits({
    redisClient,
    dailyBudgetUsd: config.PREPARATION_DAILY_BUDGET_USD,
    inputUsdPerMillionTokens: config.OPENROUTER_INPUT_USD_PER_MILLION_TOKENS,
    outputUsdPerMillionTokens: config.OPENROUTER_OUTPUT_USD_PER_MILLION_TOKENS,
    maxRequestsPerMinute: config.PREPARATION_RATE_LIMIT_PER_MINUTE,
    log,
  });
  return createPreparationBriefService({
    generateReply,
    limits,
    isModelAllowed: (modelId) => allowed.has(modelId),
    log,
  });
}
