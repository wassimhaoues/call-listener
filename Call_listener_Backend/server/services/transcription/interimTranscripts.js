// Interim (in-progress) transcript lines for clients with the `interim`
// capability. Interim text is display-only: it is never stored in chat
// history, never replayed on resume, and never reaches the classifier or a
// model. See docs/protocols/websocket.md#interim-transcripts.

/** At most one interim frame per source every 200 ms (≤ 5 per second). */
export const INTERIM_MIN_INTERVAL_MS = 200;

/** Interim text is bounded; the newest speech (the tail) is kept. */
export const MAX_INTERIM_CHARS = 500;

/** Trimmed interim text, keeping at most the last MAX_INTERIM_CHARS characters. */
export function boundInterimText(text) {
  if (typeof text !== "string") return "";
  const trimmed = text.trim();
  if (trimmed.length <= MAX_INTERIM_CHARS) return trimmed;
  return trimmed.slice(-MAX_INTERIM_CHARS).trimStart();
}

/**
 * Per-source throttle for interim lines. `push` sends immediately when the
 * source has been quiet for `intervalMs`, otherwise it keeps only the newest
 * text and sends it when the interval elapses. Unchanged text is not resent.
 *
 * `settle(label)` ends the current line (its utterance completed or was
 * abandoned): pending text is dropped and the function reports whether an
 * interim line had been sent, so the caller can tell the client to clear it.
 * The send time is kept, so the rate limit also holds across utterances.
 */
export function createInterimThrottle({
  send,
  intervalMs = INTERIM_MIN_INTERVAL_MS,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  if (typeof send !== "function") throw new TypeError("send is required");
  const sources = new Map();

  function stateFor(label) {
    let state = sources.get(label);
    if (!state) {
      state = { lastSentAt: Number.NEGATIVE_INFINITY, lastText: "", pending: null, timer: null };
      sources.set(label, state);
    }
    return state;
  }

  function flush(label) {
    const state = stateFor(label);
    state.timer = null;
    const text = state.pending;
    state.pending = null;
    if (!text || text === state.lastText) return;
    state.lastText = text;
    state.lastSentAt = now();
    send(label, text);
  }

  return {
    push(label, text) {
      const bounded = boundInterimText(text);
      if (!bounded) return;
      const state = stateFor(label);
      state.pending = bounded;
      if (state.timer) return;
      const wait = state.lastSentAt + intervalMs - now();
      if (wait <= 0) {
        flush(label);
        return;
      }
      state.timer = setTimer(() => flush(label), wait);
    },

    settle(label) {
      const state = sources.get(label);
      if (!state) return false;
      clearTimer(state.timer);
      state.timer = null;
      state.pending = null;
      const shown = state.lastText !== "";
      state.lastText = "";
      return shown;
    },

    /** Drop every pending line and timer (pause, end, close, or downgrade). */
    cancelAll() {
      for (const state of sources.values()) clearTimer(state.timer);
      sources.clear();
    },
  };
}
