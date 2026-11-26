import { isValidModelId } from "./modelAllowlist.js";

const ENV_NAME = "OPENROUTER_MODEL_PRICES";
export const MAX_MODEL_PRICES_LENGTH = 16_384;
export const MAX_PRICED_MODELS = 50;
// Sanity ceiling: no chat model costs anywhere near $10,000 per million tokens.
export const MAX_USD_PER_MILLION_TOKENS = 10_000;
const PRICE_FIELDS = ["input", "output"];

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parsePrice(modelId, entry) {
  if (!isPlainObject(entry)) {
    throw new Error(`${ENV_NAME} entry for ${modelId} must be an object with input and output prices`);
  }
  const unknown = Object.keys(entry).filter((key) => !PRICE_FIELDS.includes(key));
  if (unknown.length) {
    throw new Error(`${ENV_NAME} entry for ${modelId} accepts only input and output`);
  }
  const prices = {};
  for (const field of PRICE_FIELDS) {
    const value = entry[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_USD_PER_MILLION_TOKENS) {
      throw new Error(
        `${ENV_NAME} ${field} price for ${modelId} must be a number from 0 to ${MAX_USD_PER_MILLION_TOKENS} USD per million tokens`
      );
    }
    prices[field] = value;
  }
  return { inputUsdPerMillionTokens: prices.input, outputUsdPerMillionTokens: prices.output };
}

/**
 * Parse `OPENROUTER_MODEL_PRICES`: a JSON object mapping a model ID to
 * `{ "input": <USD per million tokens>, "output": <USD per million tokens> }`.
 * Returns a Map (never a plain object, so a provider-reported model string can
 * never resolve to an inherited property). Errors never echo the raw value.
 */
export function parseModelPrices(value) {
  const prices = new Map();
  const raw = String(value ?? "").trim();
  if (!raw) return prices;
  if (raw.length > MAX_MODEL_PRICES_LENGTH) {
    throw new Error(`${ENV_NAME} must be at most ${MAX_MODEL_PRICES_LENGTH} characters`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${ENV_NAME} must be valid JSON`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`${ENV_NAME} must be a JSON object keyed by model ID`);
  }
  const entries = Object.entries(parsed);
  if (entries.length > MAX_PRICED_MODELS) {
    throw new Error(`${ENV_NAME} accepts at most ${MAX_PRICED_MODELS} models`);
  }
  for (const [modelId, entry] of entries) {
    if (!isValidModelId(modelId)) {
      throw new Error(`${ENV_NAME} contains an invalid model ID`);
    }
    prices.set(modelId, parsePrice(modelId, entry));
  }
  return prices;
}

/**
 * Build the price table used for billing. Table entries win; the default
 * model alone may fall back to the single-price variables
 * (`OPENROUTER_INPUT/OUTPUT_USD_PER_MILLION_TOKENS`) for backward
 * compatibility. With `requireAll`, every allowlisted model must be priced.
 */
export function resolveModelPrices({
  value,
  allowedModels = [],
  defaultModel,
  defaultInputUsdPerMillionTokens,
  defaultOutputUsdPerMillionTokens,
  requireAll = true,
} = {}) {
  const prices = parseModelPrices(value);
  if (defaultModel && !prices.has(defaultModel)) {
    prices.set(defaultModel, {
      inputUsdPerMillionTokens: defaultInputUsdPerMillionTokens,
      outputUsdPerMillionTokens: defaultOutputUsdPerMillionTokens,
    });
  }
  if (requireAll) {
    const missing = allowedModels.filter((modelId) => !prices.has(modelId));
    if (missing.length) {
      throw new Error(
        `${ENV_NAME} has no price for allowlisted model(s): ${missing.join(", ")}. ` +
        "Add an { \"input\": <usd/M>, \"output\": <usd/M> } entry for each one"
      );
    }
  }
  return prices;
}
