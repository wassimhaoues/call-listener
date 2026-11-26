import test from "node:test";
import assert from "node:assert/strict";
import { createReplayHarness } from "./helpers/replayHarness.js";
import { createReplayMetrics, createFakeClock } from "./helpers/replayMetrics.js";
import { estimatedCostUsd, loadContexts, loadFixture, loadProviderResponses } from "./helpers/fixtures.js";

const contexts = loadContexts();
const { responses } = loadProviderResponses();
const SESSIONS = [
  "sessions/en-two-channel.json",
  "sessions/fr-behavioral.json",
  "sessions/en-budget-exhausted.json",
  "sessions/en-streaming.json",
  "sessions/en-actions.json",
  "sessions/en-debrief.json",
];

async function replay(session, metrics) {
  const harness = createReplayHarness({
    responses,
    contexts,
    providerScript: session.steps.filter((step) => step.provider).map((step) => step.provider),
    ...session.harness,
  });
  const expected = [];

  for (const [index, step] of session.steps.entries()) {
    const label = `${session.id} step ${index + 1} (${step.label || step.type})`;
    const callsBefore = harness.provider.calls.length;
    await metrics.measure(step.label || step.type, async () => {
      await harness.runStep(step);
      expected.push(...step.expect);
      await harness.waitForOutbound(expected.length, label);
      await harness.settle();
    });
    assert.deepEqual(harness.outbound, expected, `outbound mismatch after ${label}`);

    const newCalls = harness.provider.calls.slice(callsBefore);
    assert.deepEqual(
      newCalls.map((call) => call.name),
      step.provider ? [step.provider] : [],
      `provider calls after ${label}`
    );
    for (const fragment of step.providerPromptIncludes || []) {
      assert.ok(newCalls[0].system.includes(fragment), `${label}: prompt should include "${fragment}"`);
    }
    for (const fragment of step.providerPromptExcludes || []) {
      assert.ok(!newCalls[0].system.includes(fragment), `${label}: prompt should exclude "${fragment}"`);
    }
    // The user (data) message: the history, or the debrief's JSON data.
    for (const fragment of step.providerDataIncludes || []) {
      assert.ok(newCalls[0].history.includes(fragment), `${label}: provider data should include ${fragment}`);
    }
    if (step.providerHistoryEndsWith) {
      assert.ok(
        newCalls[0].history.endsWith(step.providerHistoryEndsWith),
        `${label}: provider history should end with the completed question`
      );
    }
  }

  // Let any late provider settlement or timer run before the final checks.
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.outbound, expected, `${session.id}: output appeared after the last step`);
  return harness;
}

for (const path of SESSIONS) {
  const session = loadFixture(path);

  test(`replays ${session.id} with the exact outbound message sequence`, async (t) => {
    const metrics = createReplayMetrics();
    const harness = await replay(session, metrics);
    const { final } = session;

    assert.deepEqual(
      Object.entries(harness.services).map(([label, service]) => ({
        label,
        language: service.conn.options.language,
        chunks: service.conn.sent.length,
        finishCalls: service.conn.finishCalls,
      })),
      final.streams,
      "one Deepgram stream per channel, opened in the context language and finished once"
    );
    assert.equal(harness.deepgram.connections.length, final.streams.length, "no stream reopened after end");

    const stored = await harness.ContextStore.get(harness.sessionId);
    assert.equal(stored.settings.transcriptionLanguage, final.storedTranscriptionLanguage);

    const history = await harness.ChatHistory.get(harness.sessionId);
    assert.deepEqual(history.map((entry) => [entry.role, entry.text]), final.history);

    assert.deepEqual(
      harness.provider.calls.map(({ name, status }) => ({ name, status })),
      final.providerCalls
    );
    assert.equal(harness.provider.remaining(), 0, "every scripted provider response was consumed");
    assert.equal(harness.provider.pendingCount(), 0, "no provider request left in flight after end");

    assert.deepEqual(harness.usageCalls, final.usage);
    // `final.spentUsd` is the reported-usage spend; replies listed in
    // `final.estimatedUsage` reported none and are charged a char-based estimate.
    const estimatedCalls = harness.provider.calls.filter((call) =>
      call.status === "resolved" && (final.estimatedUsage || []).includes(call.name));
    assert.equal(estimatedCalls.length, (final.estimatedUsage || []).length);
    assert.equal(harness.estimatedUsage.length, estimatedCalls.length, "every usage-less reply is charged an estimate");
    const expectedSpentUsd = final.spentUsd + estimatedCalls.reduce(
      (sum, call) => sum + estimatedCostUsd(call, responses[call.name], session.harness),
      0
    );
    const { spentUsd } = await harness.Budget.canGenerate(harness.sessionId);
    assert.ok(Math.abs(spentUsd - expectedSpentUsd) < 1e-12, `spent ${spentUsd}, expected ${expectedSpentUsd}`);
    if (estimatedCalls.length) assert.ok(spentUsd > final.spentUsd, "missing usage is not recorded as free");

    const steps = metrics.steps();
    assert.equal(steps.length, session.steps.length);
    assert.ok(steps.every((step) => Number.isFinite(step.durationMs) && step.durationMs >= 0));
    const summary = metrics.summary();
    t.diagnostic(
      `${session.id}: ${summary.count} steps in ${summary.totalMs.toFixed(1)} ms ` +
      `(slowest: "${summary.slowest}" ${summary.maxMs.toFixed(1)} ms; synthetic, not a latency baseline)`
    );
  });
}

test("aborted and superseded generations never reach the client or the history", async () => {
  const session = loadFixture("sessions/en-two-channel.json");
  const harness = await replay(session, createReplayMetrics());

  const aborted = harness.provider.calls.filter((call) => call.name === "hangUntilAborted");
  assert.equal(aborted.length, 2);
  assert.ok(aborted.every((call) => call.status === "rejected" && call.error?.message));
  const failures = harness.outbound.filter((message) => message.generation?.state === "failed");
  assert.equal(failures.length, 1, "only the 429 produces a visible failure; aborts stay silent");
  assert.equal(harness.streamManager.summarize().closed, true);
});

test("replay metrics record per-step durations from an injected clock", async () => {
  const clock = createFakeClock();
  const metrics = createReplayMetrics({ now: clock.now });

  await metrics.measure("transcript", async () => { clock.advance(3); });
  await metrics.measure("generation", async () => { clock.advance(40); });
  await assert.rejects(
    metrics.measure("failing step", async () => { clock.advance(2); throw new Error("boom"); }),
    /boom/
  );

  assert.deepEqual(metrics.steps(), [
    { label: "transcript", durationMs: 3 },
    { label: "generation", durationMs: 40 },
    { label: "failing step", durationMs: 2 },
  ]);
  assert.deepEqual(metrics.summary(), { count: 3, totalMs: 45, maxMs: 40, slowest: "generation" });
});

test("an introduction that completes after end is not sent", async () => {
  const harness = createReplayHarness({ responses, contexts, providerScript: ["lateIntro"] });
  const pendingContext = harness.send({ context: contexts.valid.validEn.payload });
  await harness.waitUntil(() => harness.provider.pendingCount() === 1, "the intro request");

  await harness.send({ end: true });
  harness.provider.calls[0].release?.();
  await pendingContext;
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.outbound, [], "no intro, no error after end");
  assert.equal(harness.provider.calls[0].status, "rejected", "the intro request was aborted");
  assert.equal(harness.provider.pendingCount(), 0);
  assert.deepEqual(harness.usageCalls, []);
});

test("a context sent after end does not start an introduction", async () => {
  const harness = createReplayHarness({ responses, contexts });
  await harness.send({ end: true });
  await harness.send({ context: contexts.valid.validEn.payload });

  assert.deepEqual(harness.outbound, []);
  assert.equal(harness.provider.calls.length, 0);
});

test("a newer context supersedes an in-flight introduction", async () => {
  const harness = createReplayHarness({
    responses,
    contexts,
    providerScript: ["hangUntilAborted", "introSuccess"],
  });
  const firstContext = harness.send({ context: contexts.valid.validEn.payload });
  await harness.waitUntil(() => harness.provider.pendingCount() === 1, "the first intro request");

  await harness.send({ context: contexts.valid.validEn.payload });
  await firstContext;

  assert.deepEqual(harness.outbound, [
    { ai_reply: responses.introSuccess.content, model: { selected: "fixture/model", actual: null } },
  ]);
  assert.deepEqual(
    harness.provider.calls.map(({ name, status }) => ({ name, status })),
    [
      { name: "hangUntilAborted", status: "rejected" },
      { name: "introSuccess", status: "resolved" },
    ]
  );
  await harness.streamManager.closeAll();
});
