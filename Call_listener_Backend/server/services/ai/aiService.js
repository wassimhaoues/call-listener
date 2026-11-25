import { createGroqReplyGenerator } from "./groqService.js";
import { createOpenRouterReplyGenerator } from "./openRouterService.js";

/** Select the configured provider without leaking provider details to callers. */
export function createAiReplyGenerator({
  provider = "groq",
  groqApiKey,
  groqModel,
  openRouterApiKey,
  openRouterModel,
  openRouterMaxOutputTokens,
  openRouterRequestTimeoutMs,
  log,
  dependencies = {},
} = {}) {
  if (provider === "groq") {
    return createGroqReplyGenerator({
      apiKey: groqApiKey,
      model: groqModel,
      log,
      ...dependencies.groq,
    });
  }
  if (provider === "openrouter") {
    return createOpenRouterReplyGenerator({
      apiKey: openRouterApiKey,
      model: openRouterModel,
      maxOutputTokens: openRouterMaxOutputTokens,
      requestTimeoutMs: openRouterRequestTimeoutMs,
      log,
      ...dependencies.openrouter,
    });
  }
  throw new TypeError(`Unsupported AI provider: ${provider}`);
}
