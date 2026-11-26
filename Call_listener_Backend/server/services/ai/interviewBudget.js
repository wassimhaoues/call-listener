import { loggers } from "../../core/logger/index.js";
import { createSinglePricing, tokensCostUsd } from "./modelPricing.js";

const DEFAULT_TTL_SECONDS = 7_200;
// Rough upper-leaning heuristic used only when the provider omits usage.
export const ESTIMATED_CHARS_PER_TOKEN = 4;

/** Estimate a token count from a character count: ceil(chars / 4). */
export function estimateTokens(chars) {
  const count = Number(chars);
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.ceil(count / ESTIMATED_CHARS_PER_TOKEN);
}

function asNonNegativeNumber(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative number`);
  }
}

/**
 * The pricing a budget charges with: a per-model `pricing` (from
 * modelPricing.js) or, for older callers, one input/output price pair.
 */
export function pricingFrom({ pricing, inputUsdPerMillionTokens, outputUsdPerMillionTokens, log } = {}) {
  if (pricing) {
    if (typeof pricing.resolve !== "function" || typeof pricing.priceFor !== "function") {
      throw new TypeError("pricing must come from createModelPricing");
    }
    return pricing;
  }
  asNonNegativeNumber(inputUsdPerMillionTokens, "inputUsdPerMillionTokens");
  asNonNegativeNumber(outputUsdPerMillionTokens, "outputUsdPerMillionTokens");
  return createSinglePricing({ inputUsdPerMillionTokens, outputUsdPerMillionTokens, log });
}

/**
 * Tracks reported provider usage for one ephemeral interview session. Pricing
 * is passed explicitly so this service never assumes one provider's costs for
 * another provider. Each reply is priced with the model that served it, as
 * the adapter reports in the usage basis (`{ model, actualModel }`).
 *
 * Two ceilings stop generation: `maxUsd` of charged cost and, optionally,
 * `maxCalls` charged model calls (every attempt that reports or is estimated
 * to have used tokens), which bounds a session even when a model is cheap or
 * mispriced. Both counters are updated atomically (HINCRBYFLOAT / HINCRBY), so
 * concurrent charges for one session are never lost.
 */
export function createInterviewBudget({
  redisClient,
  maxUsd,
  pricing: modelPricing,
  inputUsdPerMillionTokens,
  outputUsdPerMillionTokens,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  maxCalls = Infinity,
  log = loggers.ai,
} = {}) {
  if (!redisClient) throw new TypeError("redisClient is required");
  asNonNegativeNumber(maxUsd, "maxUsd");
  if (maxCalls !== Infinity && (!Number.isInteger(maxCalls) || maxCalls < 1)) {
    throw new TypeError("maxCalls must be a positive integer");
  }
  const pricing = pricingFrom({ pricing: modelPricing, inputUsdPerMillionTokens, outputUsdPerMillionTokens, log });
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) {
    throw new TypeError("ttlSeconds must be a positive integer");
  }

  const keyFor = (sessionId) => `budget:${sessionId}`;

  async function readCounter(sessionId, field) {
    const value = Number((await redisClient.hget(keyFor(sessionId), field)) || 0);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }

  return {
    async canGenerate(sessionId) {
      const spentUsd = await readCounter(sessionId, "spentUsd");
      const calls = await readCounter(sessionId, "calls");
      return { allowed: spentUsd < maxUsd && calls < maxCalls, spentUsd, maxUsd, calls };
    },

    /**
     * Record one reply's cost. When the provider omits a token count, charge a
     * conservative estimate from `estimateBasis` ({ inputChars, outputChars })
     * instead of silently recording zero. `estimateBasis.actualModel` and
     * `estimateBasis.model` pick the price; an unpriced or missing model is
     * charged at the default model's price.
     */
    async recordUsage(sessionId, usage, estimateBasis = {}) {
      const reportedInput = usage?.input_tokens ?? usage?.prompt_tokens;
      const reportedOutput = usage?.output_tokens ?? usage?.completion_tokens;
      const estimatedInput = reportedInput === undefined || reportedInput === null;
      const estimatedOutput = reportedOutput === undefined || reportedOutput === null;
      const inputTokens = estimatedInput
        ? estimateTokens(estimateBasis.inputChars)
        : Number(reportedInput);
      const outputTokens = estimatedOutput
        ? estimateTokens(estimateBasis.outputChars)
        : Number(reportedOutput);
      if (!Number.isFinite(inputTokens) || inputTokens < 0 || !Number.isFinite(outputTokens) || outputTokens < 0) {
        throw new TypeError("usage token counts must be non-negative numbers");
      }
      const estimated = estimatedInput || estimatedOutput;
      if (estimated) {
        // Metadata only: never log prompt, history, or reply text.
        log.warn(
          `Provider reported no ${estimatedInput && estimatedOutput ? "usage" : estimatedInput ? "input usage" : "output usage"} ` +
          `for session [${sessionId}]; charging an estimate of ${inputTokens} input / ${outputTokens} output tokens`
        );
      }
      const price = pricing.resolve(estimateBasis);
      const costUsd = tokensCostUsd(price, inputTokens, outputTokens);
      const key = keyFor(sessionId);
      const spentUsd = Number(await redisClient.hincrbyfloat(key, "spentUsd", costUsd));
      const calls = Number(await redisClient.hincrby(key, "calls", 1));
      await redisClient.hset(key, {
        lastInputTokens: String(inputTokens),
        lastOutputTokens: String(outputTokens),
        lastUsageEstimated: estimated ? "1" : "0",
        lastPricedModel: price.model || "default",
      });
      await redisClient.expire(key, ttlSeconds);
      log.debug(`Recorded provider usage for session [${sessionId}]`);
      const exhausted = spentUsd >= maxUsd || calls >= maxCalls;
      return { costUsd, spentUsd, maxUsd, calls, exhausted, estimated, model: price.model };
    },

    async clear(sessionId) {
      await redisClient.del(keyFor(sessionId));
    },
  };
}
