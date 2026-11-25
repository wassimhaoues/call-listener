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

/** Create an OpenRouter/LangChain adapter behind the shared reply contract. */
export function createOpenRouterReplyGenerator({
  apiKey,
  model,
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
  const client = new ChatOpenRouterClass({ apiKey, model, maxTokens: maxOutputTokens });

  return async function generateReply(systemPrompt, formattedHistory, { signal, onUsage } = {}) {
    const deadline = withRequestDeadline(signal, requestTimeoutMs);
    try {
      log?.info(`Generating AI reply through OpenRouter model ${model}...`);
      const response = await client.invoke(
        [new SystemMessage(systemPrompt), new HumanMessage(formattedHistory)],
        { signal: deadline.signal }
      );
      const text = contentToText(response.content);
      await onUsage?.(response.usage_metadata || response.response_metadata?.usage);
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
