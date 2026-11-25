import { loggers } from "../../core/logger/index.js";

const DEFAULT_TTL_SECONDS = 7_200;

/** Store ephemeral candidate/interview context with an explicit expiry. */
export function createContextStore({
  redisClient,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  log = loggers.chat,
} = {}) {
  if (!redisClient) throw new TypeError("redisClient is required");
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) {
    throw new TypeError("ttlSeconds must be a positive integer");
  }

  const keyFor = (sessionId) => `context:${sessionId}`;

  return {
    async set(sessionId, context) {
      try {
        await redisClient.set(
          keyFor(sessionId),
          JSON.stringify(context),
          "EX",
          ttlSeconds
        );
        log.debug(`📦 Context saved for [${sessionId}]`);
      } catch (error) {
        log.error(`❌ Failed to save context for [${sessionId}]: %o`, error);
      }
    },

    async get(sessionId) {
      try {
        const raw = await redisClient.get(keyFor(sessionId));
        return raw ? JSON.parse(raw) : null;
      } catch (error) {
        log.error(`❌ Failed to get context for [${sessionId}]: %o`, error);
        return null;
      }
    },

    async clear(sessionId) {
      try {
        await redisClient.del(keyFor(sessionId));
        log.info(`🧹 Cleared context for [${sessionId}]`);
      } catch (error) {
        log.error(`❌ Failed to clear context for [${sessionId}]: %o`, error);
      }
    },
  };
}
