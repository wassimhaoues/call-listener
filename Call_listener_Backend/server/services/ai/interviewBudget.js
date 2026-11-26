import { loggers } from "../../core/logger/index.js";

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
 * Tracks reported provider usage for one ephemeral interview session. Pricing
 * is passed explicitly so this service never assumes one provider's costs for
 * another provider.
 */
export function createInterviewBudget({
  redisClient,
  maxUsd,
  inputUsdPerMillionTokens,
  outputUsdPerMillionTokens,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  log = loggers.ai,
} = {}) {
  if (!redisClient) throw new TypeError("redisClient is required");
  asNonNegativeNumber(maxUsd, "maxUsd");
  asNonNegativeNumber(inputUsdPerMillionTokens, "inputUsdPerMillionTokens");
  asNonNegativeNumber(outputUsdPerMillionTokens, "outputUsdPerMillionTokens");
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) {
    throw new TypeError("ttlSeconds must be a positive integer");
  }

  const keyFor = (sessionId) => `budget:${sessionId}`;

  async function getSpentUsd(sessionId) {
    const raw = await redisClient.hget(keyFor(sessionId), "spentUsd");
    const spentUsd = Number(raw || 0);
    return Number.isFinite(spentUsd) && spentUsd >= 0 ? spentUsd : 0;
  }

  return {
    async canGenerate(sessionId) {
      const spentUsd = await getSpentUsd(sessionId);
      return { allowed: spentUsd < maxUsd, spentUsd, maxUsd };
    },

    /**
     * Record one reply's cost. When the provider omits a token count, charge a
     * conservative estimate from `estimateBasis` ({ inputChars, outputChars })
     * instead of silently recording zero.
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
      const costUsd = (
        (inputTokens * inputUsdPerMillionTokens + outputTokens * outputUsdPerMillionTokens) /
        1_000_000
      );
      const spentUsd = await getSpentUsd(sessionId) + costUsd;
      await redisClient.hset(keyFor(sessionId), {
        spentUsd: String(spentUsd),
        lastInputTokens: String(inputTokens),
        lastOutputTokens: String(outputTokens),
        lastUsageEstimated: estimated ? "1" : "0",
      });
      await redisClient.expire(keyFor(sessionId), ttlSeconds);
      log.debug(`Recorded provider usage for session [${sessionId}]`);
      return { costUsd, spentUsd, maxUsd, exhausted: spentUsd >= maxUsd, estimated };
    },

    async clear(sessionId) {
      await redisClient.del(keyFor(sessionId));
    },
  };
}
