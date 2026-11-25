import { ChatOpenRouter } from "@langchain/openrouter";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

function contentToText(content) {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => typeof part === "string" ? part : part?.text || "")
      .join("")
      .trim();
  }
  return "";
}

function withRequestDeadline(signal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(signal.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("OpenRouter request deadline exceeded"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

function actualModelFrom(response) {
  const metadata = response?.response_metadata || {};
  const actual = metadata.model_name || metadata.model;
  return typeof actual === "string" && actual ? actual.slice(0, 160) : null;
}

/**
 * Create an OpenRouter/LangChain adapter behind the shared reply contract.
 *
 * `model` is the configured default. A caller may pin a different model per
 * request with `{ model }`; selections must already be allowlist-validated, and
 * `allowedModels` (when given) is enforced again here as a defensive check.
 */
export function createOpenRouterReplyGenerator({
  apiKey,
  model,
  allowedModels,
  maxOutputTokens,
  requestTimeoutMs = 10_000,
  ChatOpenRouterClass = ChatOpenRouter,
  log,
} = {}) {
  if (!apiKey) throw new TypeError("OpenRouter apiKey is required");
  if (!model) throw new TypeError("OpenRouter model is required");
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new TypeError("OpenRouter requestTimeoutMs must be a positive number");
  }
  const allowed = allowedModels ? new Set(allowedModels) : null;
  const clients = new Map();
  const clientFor = (modelId) => {
    if (!clients.has(modelId)) {
      clients.set(modelId, new ChatOpenRouterClass({ apiKey, model: modelId, maxTokens: maxOutputTokens }));
    }
    return clients.get(modelId);
  };
  clientFor(model);

  return async function generateReply(
    systemPrompt,
    formattedHistory,
    { signal, onUsage, onModel, model: requestedModel } = {}
  ) {
    const selectedModel = requestedModel || model;
    if (allowed && !allowed.has(selectedModel)) {
      const error = new Error("OpenRouter unsupported_model");
      error.code = "unsupported_model";
      throw error;
    }
    const deadline = withRequestDeadline(signal, requestTimeoutMs);
    try {
      log?.info(`Generating AI reply through OpenRouter model ${selectedModel}...`);
      const response = await clientFor(selectedModel).invoke(
        [new SystemMessage(systemPrompt), new HumanMessage(formattedHistory)],
        { signal: deadline.signal }
      );
      const text = contentToText(response.content);
      await onUsage?.(response.usage_metadata || response.response_metadata?.usage);
      onModel?.({ selected: selectedModel, actual: actualModelFrom(response) });
      log?.info(`OpenRouter reply generated (${text.length} chars)`);
      return text;
    } catch (error) {
      const code = deadline.didTimeout()
        ? "provider_timeout"
        : signal?.aborted
          ? "provider_aborted"
          : "provider_request_failed";
      const normalized = new Error(`OpenRouter ${code}: ${error?.message || "unknown error"}`);
      normalized.code = code;
      normalized.cause = error;
      log?.error("OpenRouter API error (%s): %o", code, error);
      throw normalized;
    } finally {
      deadline.cleanup();
    }
  };
}
