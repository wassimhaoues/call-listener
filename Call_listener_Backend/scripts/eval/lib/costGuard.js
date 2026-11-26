import { parseModelAllowlist } from "../../../server/config/modelAllowlist.js";
import { resolveModelPrices } from "../../../server/config/modelPrices.js";
import { estimateTokens } from "../../../server/services/ai/interviewBudget.js";
import { createModelPricing } from "../../../server/services/ai/modelPricing.js";

// Same defaults as server/config/env.js. That module is not imported because
// it requires Deepgram, Redis, and JWT settings the evaluation never uses.
export const DEFAULT_OPENROUTER_MODEL = "openai/gpt-5.6-luna";
export const DEFAULT_INPUT_USD_PER_MILLION = 0.2;
export const DEFAULT_OUTPUT_USD_PER_MILLION = 1.2;
export const DEFAULT_MAX_OUTPUT_TOKENS = 600;
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** A configuration problem that must stop the run before any model call. */
export class EvalConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "EvalConfigError";
  }
}

function numberFrom(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new EvalConfigError(`${key} must be a non-negative number`);
  }
  return value;
}

function toEvalPrices(price) {
  return { inputUsdPerMillion: price.inputUsdPerMillionTokens, outputUsdPerMillion: price.outputUsdPerMillionTokens };
}

/**
 * Per-model pricing read the same way as the server: OPENROUTER_MODEL_PRICES,
 * with the single-price pair as the default model's price. `requiredModels`
 * must all be priced (the live run's selected model).
 */
export function resolvePricing(env = {}, { requiredModels = [] } = {}) {
  const defaultModel = env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL;
  const defaultPrice = {
    inputUsdPerMillionTokens: numberFrom(env, "OPENROUTER_INPUT_USD_PER_MILLION_TOKENS", DEFAULT_INPUT_USD_PER_MILLION),
    outputUsdPerMillionTokens: numberFrom(env, "OPENROUTER_OUTPUT_USD_PER_MILLION_TOKENS", DEFAULT_OUTPUT_USD_PER_MILLION),
  };
  let table;
  try {
    table = resolveModelPrices({
      value: env.OPENROUTER_MODEL_PRICES,
      allowedModels: requiredModels,
      defaultModel,
      defaultInputUsdPerMillionTokens: defaultPrice.inputUsdPerMillionTokens,
      defaultOutputUsdPerMillionTokens: defaultPrice.outputUsdPerMillionTokens,
    });
  } catch (error) {
    throw new EvalConfigError(error.message);
  }
  return createModelPricing({ prices: table, defaultModel, defaultPrice });
}

/** Configured per-million prices of `model` (default: the default model). */
export function resolvePrices(env, model) {
  const pricing = resolvePricing(env, { requiredModels: model ? [model] : [] });
  return toEvalPrices(pricing.priceFor(model));
}

export function tokensCostUsd(inputTokens, outputTokens, prices) {
  return (inputTokens * prices.inputUsdPerMillion + outputTokens * prices.outputUsdPerMillion) / 1_000_000;
}

/**
 * Worst-case price of one call: the prompt estimated as ceil(chars / 4)
 * tokens (the interview budget's heuristic) plus the full output-token cap.
 */
export function estimateCallCostUsd({ inputChars, maxOutputTokens, prices }) {
  return tokensCostUsd(estimateTokens(inputChars), maxOutputTokens, prices);
}

/**
 * Token counts and cost of one reply; falls back to the estimate when usage is
 * missing. With `pricing`, the reply is charged at the price of the model the
 * adapter reports in `basis` (`actualModel`, then `model`), else `prices`.
 */
export function usageCost({ usage, basis = {}, prices: configuredPrices, pricing }) {
  const reportsModel = Boolean(basis?.actualModel || basis?.model);
  const prices = pricing && reportsModel ? toEvalPrices(pricing.resolve(basis)) : configuredPrices;
  const reportedInput = usage?.input_tokens ?? usage?.prompt_tokens;
  const reportedOutput = usage?.output_tokens ?? usage?.completion_tokens;
  const inputMissing = !Number.isFinite(reportedInput);
  const outputMissing = !Number.isFinite(reportedOutput);
  const inputTokens = inputMissing ? estimateTokens(basis.inputChars) : reportedInput;
  const outputTokens = outputMissing ? estimateTokens(basis.outputChars) : reportedOutput;
  return {
    inputTokens,
    outputTokens,
    costUsd: tokensCostUsd(inputTokens, outputTokens, prices),
    estimated: inputMissing || outputMissing,
  };
}

/** Running spend for a live run; a call is allowed only if its worst case fits. */
export function createSpendGuard(maxUsd) {
  let spentUsd = 0;
  return {
    canAfford: (worstCaseUsd) => spentUsd + worstCaseUsd <= maxUsd,
    record: (costUsd) => {
      spentUsd += costUsd;
    },
    get spentUsd() {
      return spentUsd;
    },
  };
}

function parseMaxUsd(value) {
  if (value === undefined || value === null || value === "") {
    throw new EvalConfigError("--live requires --max-usd <n>, the most this run may spend in USD");
  }
  const maxUsd = Number(value);
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) {
    throw new EvalConfigError("--max-usd must be a positive number of USD");
  }
  return maxUsd;
}

/**
 * Decide the provider configuration. `fake` (the default) never spends
 * anything. `openrouter` needs --live, --max-usd, OPENROUTER_API_KEY,
 * non-zero prices, and an allowlisted model. The returned key is used only to
 * construct the adapter and is never printed or written to a report.
 */
export function resolveProviderConfig({ provider = "fake", live = false, maxUsd, model } = {}, env = {}) {
  if (provider === "fake") {
    if (live) throw new EvalConfigError("--live only applies to --provider openrouter");
    if (model) throw new EvalConfigError("--model only applies to --provider openrouter");
    return { provider: "fake", live: false, prices: resolvePrices(env), maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS };
  }
  if (provider !== "openrouter") {
    throw new EvalConfigError(`Unsupported provider: ${provider} (use fake or openrouter)`);
  }
  if (!live) {
    throw new EvalConfigError("--provider openrouter sends paid requests; pass --live and --max-usd <n> to confirm");
  }
  const cap = parseMaxUsd(maxUsd);
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) throw new EvalConfigError("OPENROUTER_API_KEY is required for --provider openrouter");
  const maxOutputTokens = numberFrom(env, "OPENROUTER_MAX_OUTPUT_TOKENS", DEFAULT_MAX_OUTPUT_TOKENS);
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1) {
    throw new EvalConfigError("OPENROUTER_MAX_OUTPUT_TOKENS must be a positive integer for a live cost cap");
  }
  const requestTimeoutMs = numberFrom(env, "OPENROUTER_REQUEST_TIMEOUT_MS", DEFAULT_REQUEST_TIMEOUT_MS) || DEFAULT_REQUEST_TIMEOUT_MS;
  const defaultModel = env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL;
  let allowedModels;
  try {
    allowedModels = parseModelAllowlist(env.OPENROUTER_ALLOWED_MODELS, defaultModel);
  } catch (error) {
    throw new EvalConfigError(error.message);
  }
  const selectedModel = model || defaultModel;
  if (!allowedModels.includes(selectedModel)) {
    throw new EvalConfigError(`--model ${selectedModel} is not in OPENROUTER_ALLOWED_MODELS`);
  }
  // The cap is enforced with the selected model's own price, never another's.
  const pricing = resolvePricing(env, { requiredModels: [selectedModel] });
  const prices = toEvalPrices(pricing.priceFor(selectedModel));
  if (prices.inputUsdPerMillion <= 0 || prices.outputUsdPerMillion <= 0) {
    throw new EvalConfigError(
      `Prices for ${selectedModel} (OPENROUTER_MODEL_PRICES, or OPENROUTER_INPUT_USD_PER_MILLION_TOKENS and ` +
      "OPENROUTER_OUTPUT_USD_PER_MILLION_TOKENS for the default model) must be positive for a live cost cap"
    );
  }
  return {
    provider: "openrouter",
    live: true,
    maxUsd: cap,
    apiKey,
    model: selectedModel,
    allowedModels,
    prices,
    pricing,
    maxOutputTokens,
    requestTimeoutMs,
  };
}
