export const DEFAULT_REPLAY_MAX_MESSAGES = 200;
export const DEFAULT_REPLAY_MAX_BYTES = 256 * 1024;

/**
 * Bounded, in-order buffer of serialized committed server messages, keyed by
 * their `seq`. The oldest entries are evicted first once either the message
 * count or the total byte size exceeds its limit.
 *
 * This buffer lives in process memory, so a resume must reach the same
 * backend instance. A multi-instance deployment needs a shared store (for
 * example a capped Redis stream per session) and sticky routing or a
 * session-ownership handoff.
 */
export function createReplayBuffer({
  maxMessages = DEFAULT_REPLAY_MAX_MESSAGES,
  maxBytes = DEFAULT_REPLAY_MAX_BYTES,
} = {}) {
  if (!Number.isInteger(maxMessages) || maxMessages < 1) {
    throw new TypeError("maxMessages must be a positive integer");
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("maxBytes must be a positive integer");
  }

  let entries = [];
  let totalBytes = 0;
  // Highest seq that was committed but is no longer retained.
  let evictedThroughSeq = 0;

  function evictOldest() {
    const oldest = entries.shift();
    totalBytes -= oldest.bytes;
    evictedThroughSeq = Math.max(evictedThroughSeq, oldest.seq);
  }

  return {
    /** Retain one serialized message. Returns false if it alone exceeds `maxBytes`. */
    push(seq, data) {
      const bytes = Buffer.byteLength(data);
      if (bytes > maxBytes) {
        evictedThroughSeq = Math.max(evictedThroughSeq, seq);
        return false;
      }
      entries.push({ seq, data, bytes });
      totalBytes += bytes;
      while (entries.length > maxMessages || totalBytes > maxBytes) evictOldest();
      return true;
    },

    /**
     * Retained messages with `seq > lastSeq`, oldest first. `truncated` is true
     * when a committed message after `lastSeq` was evicted and cannot be
     * replayed.
     */
    since(lastSeq) {
      return {
        messages: entries.filter((entry) => entry.seq > lastSeq).map((entry) => entry.data),
        truncated: lastSeq < evictedThroughSeq,
      };
    },

    clear() {
      entries = [];
      totalBytes = 0;
    },

    get size() {
      return entries.length;
    },

    get bytes() {
      return totalBytes;
    },
  };
}
