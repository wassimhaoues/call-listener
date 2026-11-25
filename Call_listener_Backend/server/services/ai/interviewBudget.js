import { loggers } from "../../core/logger/index.js";

const DEFAULT_TTL_SECONDS = 7_200;

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

    async recordUsage(sessionId, usage) {
      const inputTokens = Number(usage?.input_tokens ?? usage?.prompt_tokens ?? 0);
      const outputTokens = Number(usage?.output_tokens ?? usage?.completion_tokens ?? 0);
      if (!Number.isFinite(inputTokens) || inputTokens < 0 || !Number.isFinite(outputTokens) || outputTokens < 0) {
        throw new TypeError("usage token counts must be non-negative numbers");
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
      });
      await redisClient.expire(keyFor(sessionId), ttlSeconds);
      log.debug(`Recorded provider usage for session [${sessionId}]`);
      return { costUsd, spentUsd, maxUsd, exhausted: spentUsd >= maxUsd };
    },

    async clear(sessionId) {
      await redisClient.del(keyFor(sessionId));
    },
  };
}
