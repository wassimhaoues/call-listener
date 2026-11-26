import { randomInt } from "node:crypto";
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

function newProgress() {
  return { text: "", usage: undefined, metadataUsage: undefined, actual: null, emitted: false, finishReason: null };
}

function reportedUsage(progress) {
  return progress.usage || progress.metadataUsage;
}

/**
 * Consume a LangChain chat-model stream, forwarding each text delta to
 * `onToken`. No delta is forwarded once `signal` aborts (caller supersede,
 * session end, or deadline); the abort reason is thrown instead.
 *
 * `progress` records what this attempt already did so a failure can be
 * classified: a forwarded delta or reported usage makes the attempt unsafe
 * to retry, and reported usage is charged even when the attempt fails.
 */
async function streamReply(client, messages, signal, onToken, progress) {
  const stream = await client.stream(messages, { signal });
  for await (const chunk of stream) {
    if (signal.aborted) throw signal.reason ?? new Error("aborted");
    const delta = contentToRawText(chunk?.content);
    progress.usage = addUsage(progress.usage, chunk?.usage_metadata);
    if (hasFields(chunk?.response_metadata?.usage)) progress.metadataUsage = chunk.response_metadata.usage;
    progress.actual = actualModelFrom(chunk) || progress.actual;
    progress.finishReason = finishReasonFrom(chunk) || progress.finishReason;
    if (delta) {
      progress.text += delta;
      progress.emitted = true;
      onToken(delta);
    }
  }
  if (signal.aborted) throw signal.reason ?? new Error("aborted");
  return {
    text: progress.text.trim(),
    usage: reportedUsage(progress),
    actual: progress.actual,
    finishReason: progress.finishReason,
  };
}

async function invokeReply(client, messages, signal) {
  const response = await client.invoke(messages, { signal });
  return {
    text: contentToText(response.content),
    usage: response.usage_metadata || response.response_metadata?.usage,
    actual: actualModelFrom(response),
    finishReason: finishReasonFrom(response),
  };
}

function withRequestDeadline(signal, timeoutMs) {
  const controller = new AbortController();
  const startedAt = Date.now();
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
    remainingMs: () => timeoutMs - (Date.now() - startedAt),
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

// Provider answers that mean "no completion was produced": rate limiting and
// gateway/upstream unavailability. 400/401/403/404 (unsupported parameters,
// invalid key, removed model) are permanent and never retried.
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
// Failures raised while opening the connection, before the request reached
// the provider. ECONNRESET is deliberately absent: it can happen after the
// request was sent, when the provider may already be generating (and billing).
const RETRYABLE_CONNECTION_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);

export const MAX_OPENROUTER_RETRIES = 2;
export const DEFAULT_RETRY_POLICY = Object.freeze({
  maxRetries: 1,
  // Full-jitter window for the wait before a retry.
  minDelayMs: 250,
  maxDelayMs: 1_000,
  // A retry is only sent when at least this much of the deadline is left
  // after the wait, so it has a realistic chance to finish.
  minAttemptMs: 1_000,
});

/** A uniform fraction in [0, 1] for backoff jitter. */
function jitterFraction() {
  return randomInt(0, 1_001) / 1_000;
}

function statusOf(error) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  return Number.isInteger(status) && status > 0 ? status : null;
}

function connectionCodeOf(error) {
  const code = error?.cause?.code ?? error?.code;
  return typeof code === "string" && RETRYABLE_CONNECTION_CODES.has(code) ? code : null;
}

/** A short, text-free label for logs: the HTTP status or connection code. */
function failureLabel(error) {
  const status = statusOf(error);
  if (status) return `status ${status}`;
  return connectionCodeOf(error) || "no status";
}

function isRetryableError(error) {
  return RETRYABLE_STATUSES.has(statusOf(error)) || connectionCodeOf(error) !== null;
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name) ?? undefined;
  return headers[name];
}

/** `Retry-After` in milliseconds (delta-seconds or HTTP date), else null. */
export function retryAfterMs(error, now = Date.now()) {
  const raw = headerValue(error?.headers ?? error?.response?.headers, "retry-after");
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds * 1000));
  const date = Date.parse(String(raw));
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/**
 * How long to wait before retrying a failed attempt, or null when the
 * failure must surface. A retry is only safe when the attempt produced
 * nothing billable or candidate-visible and the shared request deadline
 * still fits the wait plus a useful attempt.
 */
function retryWaitMs({ error, progress, attempt, policy, deadline, random }) {
  if (deadline.signal.aborted || attempt > policy.maxRetries) return null;
  if (progress.emitted || reportedUsage(progress)) return null;
  if (!isRetryableError(error)) return null;
  const jitterMs = Math.round(policy.minDelayMs + random() * (policy.maxDelayMs - policy.minDelayMs));
  const waitMs = Math.max(jitterMs, retryAfterMs(error) ?? 0);
  return waitMs + policy.minAttemptMs <= deadline.remainingMs() ? waitMs : null;
}

function waitFor(ms, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run `attempt` until it succeeds or a failure is not safely retryable.
 * Every attempt shares `deadline`, so retries never extend the request.
 * `run` exposes the attempt count and the last attempt's progress.
 */
async function runAttempts(context) {
  const { attempt, run, policy, deadline, random, log } = context;
  run.attempts += 1;
  run.progress = newProgress();
  try {
    return await attempt(run.progress);
  } catch (error) {
    const waitMs = retryWaitMs({ error, progress: run.progress, attempt: run.attempts, policy, deadline, random });
    if (waitMs === null) throw error;
    // Metadata only: the status or connection code, never provider text.
    log?.warn?.(`OpenRouter attempt ${run.attempts} failed (${failureLabel(error)}); retrying in ${waitMs} ms`);
    await waitFor(waitMs, deadline.signal);
    // At most MAX_OPENROUTER_RETRIES + 1 attempts, so the recursion is shallow.
    return runAttempts(context);
  }
}

function failureCode(deadline, signal) {
  if (deadline.didTimeout()) return "provider_timeout";
  if (signal?.aborted) return "provider_aborted";
  return "provider_request_failed";
}

function resolveRetryPolicy(maxRetries, retryPolicy) {
  const policy = { ...DEFAULT_RETRY_POLICY, ...retryPolicy, maxRetries };
  if (!Number.isInteger(policy.maxRetries) || policy.maxRetries < 0 || policy.maxRetries > MAX_OPENROUTER_RETRIES) {
    throw new TypeError(`OpenRouter maxRetries must be an integer between 0 and ${MAX_OPENROUTER_RETRIES}`);
  }
  for (const key of ["minDelayMs", "maxDelayMs", "minAttemptMs"]) {
    if (!Number.isFinite(policy[key]) || policy[key] < 0) {
      throw new TypeError(`OpenRouter retry ${key} must be a non-negative number`);
    }
  }
  if (policy.maxDelayMs < policy.minDelayMs) {
    throw new TypeError("OpenRouter retry maxDelayMs must not be below minDelayMs");
  }
  return policy;
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

// LangChain copies the provider's `finish_reason` into `response_metadata`
// for invoked responses and for the final streamed chunk.
function finishReasonFrom(response) {
  const reason = response?.response_metadata?.finish_reason;
  return typeof reason === "string" && reason ? reason.slice(0, 40) : null;
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
 *
 * `maxRetries` (0-2, default 1) bounds the adapter's own retries; see
 * docs/plan/provider-retries.md for when a failed attempt is retried.
 * LangChain's built-in retries are disabled so this policy is the only one.
 */
export function createOpenRouterReplyGenerator({
  apiKey,
  model,
  allowedModels,
  maxOutputTokens,
  requestTimeoutMs = 10_000,
  maxRetries = DEFAULT_RETRY_POLICY.maxRetries,
  retryPolicy,
  random = jitterFraction,
  ChatOpenRouterClass = ChatOpenRouter,
  log,
} = {}) {
  if (!apiKey) throw new TypeError("OpenRouter apiKey is required");
  if (!model) throw new TypeError("OpenRouter model is required");
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new TypeError("OpenRouter requestTimeoutMs must be a positive number");
  }
  const policy = resolveRetryPolicy(maxRetries, retryPolicy);
  const allowed = allowedModels ? new Set(allowedModels) : null;
  const clients = new Map();
  // One client per (model, output cap): a request may ask for its own cap
  // (the end-of-interview debrief does), every other request uses the default.
  const clientFor = (modelId, tokens = maxOutputTokens) => {
    const key = JSON.stringify([modelId, tokens ?? null]);
    if (!clients.has(key)) {
      // `streamUsage` asks for token usage on streamed responses too, so the
      // interview budget records reported (not estimated) cost when it can.
      // `maxRetries: 0` turns off LangChain's hidden retries (6 by default).
      clients.set(key, new ChatOpenRouterClass({
        apiKey,
        model: modelId,
        maxTokens: tokens,
        streamUsage: true,
        maxRetries: 0,
      }));
    }
    return clients.get(key);
  };
  clientFor(model);

  return async function generateReply(
    systemPrompt,
    formattedHistory,
    {
      signal,
      onUsage,
      onModel,
      onToken,
      onFinish,
      model: requestedModel,
      maxOutputTokens: requestedMaxTokens,
      timeoutMs,
    } = {}
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
    const run = { attempts: 0, progress: newProgress(), charged: false };
    // The character counts let the budget charge a conservative estimate
    // when the provider omits usage; they carry no transcript text. The
    // model IDs let budgets charge the served model's price.
    const usageBasis = (outputChars, actual) => ({
      inputChars: String(systemPrompt ?? "").length + String(formattedHistory ?? "").length,
      outputChars,
      model: selectedModel,
      actualModel: actual,
      attempts: run.attempts,
    });
    try {
      log?.info(`Generating AI reply through OpenRouter model ${selectedModel}...`);
      const messages = [new SystemMessage(systemPrompt), new HumanMessage(formattedHistory)];
      const client = clientFor(selectedModel, tokens);
      // Streaming is opt-in per request; without `onToken` the adapter keeps
      // the single `invoke` call it has always made.
      const attempt = typeof onToken === "function"
        ? (progress) => streamReply(client, messages, deadline.signal, onToken, progress)
        : () => invokeReply(client, messages, deadline.signal);
      const { text, usage, actual, finishReason } = await runAttempts({ attempt, run, policy, deadline, random, log });
      run.charged = true;
      await onUsage?.(usage, usageBasis(text.length, actual));
      onModel?.({ selected: selectedModel, actual });
      // The reply hit the output-token cap and ends mid-thought.
      const truncated = finishReason === "length";
      if (truncated) log?.warn?.(`OpenRouter reply stopped at the output limit (${tokens ?? "default"} tokens)`);
      onFinish?.({ truncated });
      log?.info(`OpenRouter reply generated (${text.length} chars, ${run.attempts} attempt(s))`);
      return text;
    } catch (error) {
      const code = failureCode(deadline, signal);
      if (!run.charged) await chargeFailedAttempt(run.progress, onUsage, usageBasis, log);
      const normalized = new Error(`OpenRouter ${code}: ${error?.message || "unknown error"}`);
      normalized.code = code;
      normalized.cause = error;
      log?.error("OpenRouter API error (%s) after %d attempt(s): %o", code, run.attempts, error);
      throw normalized;
    } finally {
      deadline.cleanup();
    }
  };
}

/**
 * A failed attempt that already reported usage was billed by the provider,
 * so it is charged like a reply (and was never retried). An accounting
 * failure is logged and never replaces the provider error.
 */
async function chargeFailedAttempt(progress, onUsage, usageBasis, log) {
  const usage = reportedUsage(progress);
  if (!usage || typeof onUsage !== "function") return;
  try {
    await onUsage(usage, usageBasis(progress.text.trim().length, progress.actual));
  } catch (accountingError) {
    log?.error("OpenRouter usage accounting failed after a provider error: %o", accountingError);
  }
}
