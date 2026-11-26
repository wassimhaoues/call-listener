import { performance } from "node:perf_hooks";

/** Manually advanced clock so metric tests never depend on wall time. */
export function createFakeClock(start = 0) {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
      return current;
    },
  };
}

/**
 * Record per-step durations of a replay. Durations are informational only:
 * tests assert their shape, never real-time thresholds.
 */
export function createReplayMetrics({ now = () => performance.now() } = {}) {
  const steps = [];
  return {
    async measure(label, run) {
      const startedAt = now();
      try {
        return await run();
      } finally {
        steps.push({ label, durationMs: now() - startedAt });
      }
    },
    steps: () => steps.map((step) => ({ ...step })),
    summary() {
      const totalMs = steps.reduce((sum, step) => sum + step.durationMs, 0);
      const slowest = steps.reduce(
        (max, step) => (!max || step.durationMs > max.durationMs ? step : max),
        null
      );
      return {
        count: steps.length,
        totalMs,
        maxMs: slowest?.durationMs ?? 0,
        slowest: slowest?.label ?? null,
      };
    },
  };
}
