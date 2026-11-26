import { createHash } from "node:crypto";
import { estimateTokens } from "../ai/interviewBudget.js";

export const PREPARATION_BUDGET_TTL_SECONDS = 24 * 60 * 60;
export const PREPARATION_RATE_WINDOW_SECONDS = 60;

function assertNonNegative(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative number`);
  }
}

function tokenCount(reported, estimateChars) {
  if (reported === undefined || reported === null) {
    return { tokens: estimateTokens(estimateChars), estimated: true };
  }
  const tokens = Number(reported);
  if (!Number.isFinite(tokens) || tokens < 0) {
    throw new TypeError("usage token counts must be non-negative numbers");
  }
  return { tokens, estimated: false };
}

/**
 * Per-installation limits for model-backed preparation: a fixed-window
 * request rate and a daily spend ceiling. Keys use a hash of the JWT
 * `device_id`, so Redis never stores the raw installation ID.
 */
export function createPreparationLimits({
  redisClient,
  dailyBudgetUsd,
  inputUsdPerMillionTokens,
  outputUsdPerMillionTokens,
  maxRequestsPerMinute,
  log,
} = {}) {
  if (!redisClient) throw new TypeError("redisClient is required");
  assertNonNegative(dailyBudgetUsd, "dailyBudgetUsd");
  assertNonNegative(inputUsdPerMillionTokens, "inputUsdPerMillionTokens");
  assertNonNegative(outputUsdPerMillionTokens, "outputUsdPerMillionTokens");
  if (!Number.isInteger(maxRequestsPerMinute) || maxRequestsPerMinute < 1) {
    throw new TypeError("maxRequestsPerMinute must be a positive integer");
  }

  const keyId = (deviceId) => createHash("sha256").update(String(deviceId)).digest("hex").slice(0, 32);
  const budgetKey = (deviceId) => `prep:budget:${keyId(deviceId)}`;
  const rateKey = (deviceId) => `prep:rate:${keyId(deviceId)}`;

  async function getSpentUsd(deviceId) {
    const spent = Number((await redisClient.get(budgetKey(deviceId))) || 0);
    return Number.isFinite(spent) && spent >= 0 ? spent : 0;
  }

  return {
    /** Count one request; false once the per-minute window is full. */
    async takeRateToken(deviceId) {
      const key = rateKey(deviceId);
      const count = await redisClient.incr(key);
      if (count === 1) await redisClient.expire(key, PREPARATION_RATE_WINDOW_SECONDS);
      return count <= maxRequestsPerMinute;
    },

    async canSpend(deviceId) {
      return (await getSpentUsd(deviceId)) < dailyBudgetUsd;
    },

    /**
     * Charge one model call. A missing token count is charged with the same
     * conservative character estimate as the interview budget.
     */
    async recordUsage(deviceId, usage, estimateBasis = {}) {
      const input = tokenCount(usage?.input_tokens ?? usage?.prompt_tokens, estimateBasis.inputChars);
      const output = tokenCount(usage?.output_tokens ?? usage?.completion_tokens, estimateBasis.outputChars);
      const costUsd = (
        input.tokens * inputUsdPerMillionTokens + output.tokens * outputUsdPerMillionTokens
      ) / 1_000_000;
      const key = budgetKey(deviceId);
      const spentUsd = Number(await redisClient.incrbyfloat(key, costUsd));
      // The 24-hour window starts with the first charged request of the day.
      if ((await redisClient.ttl(key)) < 0) await redisClient.expire(key, PREPARATION_BUDGET_TTL_SECONDS);
      const estimated = input.estimated || output.estimated;
      if (estimated) {
        log?.warn?.(
          `Preparation provider reported incomplete usage; charged an estimate of ${input.tokens} input / ${output.tokens} output tokens`
        );
      }
      return { costUsd, spentUsd, estimated };
    },
  };
}
