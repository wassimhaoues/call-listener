// Deepgram can deliver the same final speech twice around an utterance
// boundary (a repeated final segment flushed into the next utterance, or the
// tail of an utterance re-finalized after `UtteranceEnd`). Without this
// filter the duplicate would be stored, shown, and classified again, so one
// interviewer question could start two paid generations.

/** Finals repeated within this window of the previous one are duplicates. */
export const UTTERANCE_DEDUP_WINDOW_MS = 3_000;

/** A repeated tail must be at least this many words to count as a duplicate. */
export const MIN_DUPLICATE_TAIL_WORDS = 3;

/** Lowercase, drop punctuation and symbols, and collapse whitespace. */
export function normalizeUtterance(text) {
  if (typeof text !== "string") return "";
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}\s]+/gu, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function countWords(normalized) {
  return normalized ? normalized.split(" ").length : 0;
}

/**
 * Near-exact duplicate: the same normalized text, or a repeat of the previous
 * utterance's last words (at least MIN_DUPLICATE_TAIL_WORDS of them). A short
 * genuine follow-up such as "Why?" is never suppressed as a tail.
 */
export function isNearDuplicate(previous, next) {
  if (!previous || !next) return false;
  if (previous === next) return true;
  return countWords(next) >= MIN_DUPLICATE_TAIL_WORDS && previous.endsWith(` ${next}`);
}

/**
 * Per-source duplicate filter for final utterances. `isDuplicate(label, text)`
 * returns true for a near-exact repeat of that source's previous utterance
 * within `windowMs`; otherwise it records `text` as the source's latest
 * utterance. A suppressed duplicate extends the window, so a burst of
 * repeats is suppressed as a whole.
 */
export function createUtteranceDeduplicator({
  windowMs = UTTERANCE_DEDUP_WINDOW_MS,
  now = Date.now,
} = {}) {
  const latest = new Map();

  return {
    isDuplicate(label, text) {
      const normalized = normalizeUtterance(text);
      const at = now();
      const previous = latest.get(label);
      if (previous && at - previous.at <= windowMs && isNearDuplicate(previous.normalized, normalized)) {
        previous.at = at;
        return true;
      }
      latest.set(label, { normalized, at });
      return false;
    },

    reset() {
      latest.clear();
    },
  };
}
