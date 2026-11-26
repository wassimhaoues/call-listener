// Reconnect schedule for the live interview socket: jittered exponential
// backoff from 0.5 s up to an 8 s cap, bounded by the server's 120 s resume
// window. See docs/protocols/websocket.md ("Resumable sessions").

export const RECONNECT_BASE_DELAY_MS = 500;
export const RECONNECT_MAX_DELAY_MS = 8_000;
export const RECONNECT_WINDOW_MS = 120_000;

const UINT32_RANGE = 2 ** 32;

// A uniform fraction in [0, 1) from the Web Crypto API.
export function randomFraction() {
  return globalThis.crypto.getRandomValues(new Uint32Array(1))[0] / UINT32_RANGE;
}

// "Equal jitter": half of the exponential step is fixed and half is random,
// so retries from many clients spread out but never collapse to zero delay.
// `attempt` is 0 for the first retry.
export function reconnectDelay(attempt, random = randomFraction) {
  const step = Math.min(
    RECONNECT_MAX_DELAY_MS,
    RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt)
  );
  const half = step / 2;
  return Math.round(half + random() * half);
}

// The delay before the next attempt, or null once that attempt would start
// after the reconnect window.
export function nextReconnectDelay({ attempt, elapsedMs, random = randomFraction }) {
  const delay = reconnectDelay(attempt, random);
  return elapsedMs + delay > RECONNECT_WINDOW_MS ? null : delay;
}
