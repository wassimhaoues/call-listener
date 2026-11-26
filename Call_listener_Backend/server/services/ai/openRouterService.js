import { ChatOpenRouter } from "@langchain/openrouter";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

// Only text parts are candidate-facing; reasoning and tool data live outside
// `content` (or in non-text parts) and are never returned or streamed.
function contentToRawText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => typeof part === "string" ? part : part?.text || "")
      .join("");
  }
  return "";
}

function contentToText(content) {
  return contentToRawText(content).trim();
}

const USAGE_TOKEN_FIELDS = ["input_tokens", "output_tokens", "total_tokens"];

// Sum token counts across streamed chunks, as LangChain's chunk `concat`
// does. OpenRouter normally reports usage once, on the final chunk.
function addUsage(total, usage) {
  if (!usage || typeof usage !== "object") return total;
  const next = { ...total };
  let counted = false;
  for (const field of USAGE_TOKEN_FIELDS) {
    if (Number.isFinite(usage[field])) {
      next[field] = (next[field] || 0) + usage[field];
      counted = true;
    }
  }
  return counted ? next : total;
}

function hasFields(value) {
  return !!value && typeof value === "object" && Object.keys(value).length > 0;
}

/**
 * Consume a LangChain chat-model stream, forwarding each text delta to
 * `onToken`. No delta is forwarded once `signal` aborts (caller supersede,
 * session end, or deadline); the abort reason is thrown instead.
 */
async function streamReply(client, messages, signal, onToken) {
  const stream = await client.stream(messages, { signal });
  let text = "";
  let usage;
  let metadataUsage;
  let actual = null;
  for await (const chunk of stream) {
    if (signal.aborted) throw signal.reason ?? new Error("aborted");
    const delta = contentToRawText(chunk?.content);
    usage = addUsage(usage, chunk?.usage_metadata);
    if (hasFields(chunk?.response_metadata?.usage)) metadataUsage = chunk.response_metadata.usage;
    actual = actualModelFrom(chunk) || actual;
    if (delta) {
      text += delta;
      onToken(delta);
    }
  }
  if (signal.aborted) throw signal.reason ?? new Error("aborted");
  return { text: text.trim(), usage: usage || metadataUsage, actual };
}

async function invokeReply(client, messages, signal) {
  const response = await client.invoke(messages, { signal });
  return {
    text: contentToText(response.content),
    usage: response.usage_metadata || response.response_metadata?.usage,
    actual: actualModelFrom(response),
  };
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

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
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
  // One client per (model, output cap): a request may ask for its own cap
  // (the end-of-interview debrief does), every other request uses the default.
  const clientFor = (modelId, tokens = maxOutputTokens) => {
    const key = JSON.stringify([modelId, tokens ?? null]);
    if (!clients.has(key)) {
      // `streamUsage` asks for token usage on streamed responses too, so the
      // interview budget records reported (not estimated) cost when it can.
      clients.set(key, new ChatOpenRouterClass({
        apiKey,
        model: modelId,
        maxTokens: tokens,
        streamUsage: true,
      }));
    }
    return clients.get(key);
  };
  clientFor(model);

  return async function generateReply(
    systemPrompt,
    formattedHistory,
    { signal, onUsage, onModel, onToken, model: requestedModel, maxOutputTokens: requestedMaxTokens, timeoutMs } = {}
  ) {
    const selectedModel = requestedModel || model;
    if (allowed && !allowed.has(selectedModel)) {
      const error = new Error("OpenRouter unsupported_model");
      error.code = "unsupported_model";
      throw error;
    }
    const tokens = isPositiveInteger(requestedMaxTokens) ? requestedMaxTokens : maxOutputTokens;
    const deadlineMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : requestTimeoutMs;
    const deadline = withRequestDeadline(signal, deadlineMs);
    try {
      log?.info(`Generating AI reply through OpenRouter model ${selectedModel}...`);
      const messages = [new SystemMessage(systemPrompt), new HumanMessage(formattedHistory)];
      const client = clientFor(selectedModel, tokens);
      // Streaming is opt-in per request; without `onToken` the adapter keeps
      // the single `invoke` call it has always made.
      const { text, usage, actual } = typeof onToken === "function"
        ? await streamReply(client, messages, deadline.signal, onToken)
        : await invokeReply(client, messages, deadline.signal);
      // The character counts let the budget charge a conservative estimate
      // when the provider omits usage; they carry no transcript text.
      await onUsage?.(usage, {
        inputChars: String(systemPrompt ?? "").length + String(formattedHistory ?? "").length,
        outputChars: text.length,
      });
      onModel?.({ selected: selectedModel, actual });
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
