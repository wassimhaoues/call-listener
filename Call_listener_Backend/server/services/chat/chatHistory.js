import { loggers } from "../../core/logger/index.js";

const DEFAULT_MAX_ENTRIES = 40;
const DEFAULT_TTL_SECONDS = 7_200;

/**
 * Store bounded, ephemeral interview turns. The adapter is explicit so tests
 * can exercise retention behavior without a real Redis instance.
 */
export function createChatHistory({
  redisClient,
  maxEntries = DEFAULT_MAX_ENTRIES,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  log = loggers.chat,
} = {}) {
  if (!redisClient) throw new TypeError("redisClient is required");
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new TypeError("maxEntries must be a positive integer");
  }
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) {
    throw new TypeError("ttlSeconds must be a positive integer");
  }

  const keyFor = (sessionId) => `chat:${sessionId}`;

  return {
    async push(sessionId, role, text) {
      if (!sessionId || !text?.trim()) return;
      try {
        const key = keyFor(sessionId);
        const entry = JSON.stringify({ role, text, ts: Date.now() });
        await redisClient.rpush(key, entry);
        await redisClient.ltrim(key, -maxEntries, -1);
        await redisClient.expire(key, ttlSeconds);
        log.debug(`💬 [${sessionId}] Added message from [${role}]`);
      } catch (error) {
        log.error(`❌ Failed to save chat message for [${sessionId}]: %o`, error);
      }
    },

    async get(sessionId) {
      try {
        const entries = await redisClient.lrange(keyFor(sessionId), 0, -1);
        return entries.flatMap((entry) => {
          try {
            return [JSON.parse(entry)];
          } catch {
            log.warn(`⚠️ Ignoring malformed chat entry for [${sessionId}]`);
            return [];
          }
        });
      } catch (error) {
        log.error(`❌ Failed to get chat history for [${sessionId}]: %o`, error);
        return [];
      }
    },

    async clear(sessionId) {
      try {
        await redisClient.del(keyFor(sessionId));
        log.info(`🧹 Cleared chat history for [${sessionId}]`);
      } catch (error) {
        log.error(`❌ Failed to clear chat history for [${sessionId}]: %o`, error);
      }
    },

    async toPrompt(sessionId) {
      const history = await this.get(sessionId);
      return history.map((entry) => `${entry.role}: ${entry.text}`).join("\n");
    },
  };
}
