import test from "node:test";
import assert from "node:assert/strict";
import { createAiReplyGenerator } from "../server/services/ai/aiService.js";
import { createFakeChatOpenRouter } from "./helpers/fakeProvider.js";
import { createReplayHarness } from "./helpers/replayHarness.js";
import { estimatedCostUsd, loadContexts, loadProviderResponses } from "./helpers/fixtures.js";

const contexts = loadContexts();
const { responses, cases } = loadProviderResponses();
const silentLog = { info() {}, error() {} };
const QUESTION = "How did you lead the migration?";
// Production retry rules (one retry) without the real backoff wait.
const FAST_RETRIES = { minDelayMs: 0, maxDelayMs: 0, minAttemptMs: 0 };

function scriptFor(providerCase) {
  return providerCase.script ?? [providerCase.response];
}

function createGenerator(script, requestTimeoutMs = 10_000) {
  const provider = createFakeChatOpenRouter({ responses, script });
  const generateReply = createAiReplyGenerator({
    provider: "openrouter",
    openRouterApiKey: "fixture-key-not-a-secret",
    openRouterModel: "fixture/model",
    openRouterMaxOutputTokens: 600,
    openRouterRequestTimeoutMs: requestTimeoutMs,
    openRouterMaxRetries: 1,
    log: silentLog,
    dependencies: { openrouter: { ChatOpenRouterClass: provider.ChatOpenRouterClass, retryPolicy: FAST_RETRIES } },
  });
  return { provider, generateReply };
}

for (const providerCase of cases) {
  test(`OpenRouter adapter: ${providerCase.name}`, async () => {
    const { provider, generateReply } = createGenerator(scriptFor(providerCase), providerCase.requestTimeoutMs);
    const controller = new AbortController();
    const usage = [];
    const bases = [];
    const request = generateReply("system prompt", "caller: question", {
      signal: controller.signal,
      onUsage: (value, estimateBasis) => {
        usage.push(value ?? null);
        bases.push(estimateBasis);
      },
    });
    if (providerCase.abortByCaller) {
      while (provider.pendingCount() === 0) await new Promise((resolve) => setImmediate(resolve));
      controller.abort(new Error("superseded"));
    }

    const { adapter } = providerCase;
    if (adapter.errorCode) {
      await assert.rejects(request, (error) => {
        assert.equal(error.code, adapter.errorCode);
        if (adapter.causeStatus) assert.equal(error.cause?.status, adapter.causeStatus);
        return true;
      });
      assert.deepEqual(usage, [], "failed requests report no usage");
    } else {
      assert.equal(await request, adapter.text);
      assert.deepEqual(usage, [adapter.usage]);
      assert.deepEqual(bases, [{
        inputChars: "system prompt".length + "caller: question".length,
        outputChars: adapter.text.length,
        model: "fixture/model",
        actualModel: null,
        attempts: providerCase.calls ?? 1,
      }], "usage is reported with char counts for a fallback estimate and the model to price");
    }
    assert.equal(provider.calls.length, providerCase.calls ?? 1, "only safe failures are retried, at most once");
  });

  if (!providerCase.session) continue;

  test(`live session: ${providerCase.name} keeps transcription and reports the right outcome`, async () => {
    const harness = createReplayHarness({
      responses,
      contexts,
      providerScript: scriptFor(providerCase),
      requestTimeoutMs: providerCase.requestTimeoutMs,
      maxRetries: 1,
      retryPolicy: FAST_RETRIES,
    });
    await harness.send({ interviewer_question: QUESTION });
    await harness.waitForOutbound(3, `the ${providerCase.name} outcome`);
    await harness.settle();

    const outcome = providerCase.session.outcome === "reply"
      ? { ai_reply: providerCase.adapter.text, model: { selected: "fixture/model", actual: null } }
      : { generation: { state: "failed" }, ai_reply: "[Erreur du modèle]" };
    assert.deepEqual(harness.outbound, [
      { speaker: "caller", transcript: QUESTION },
      { generation: { state: "thinking" } },
      outcome,
    ]);

    const history = (await harness.ChatHistory.get(harness.sessionId)).map((entry) => [entry.role, entry.text]);
    assert.deepEqual(history[0], ["caller", QUESTION], "the question is kept even when generation fails");
    assert.equal(history.length, providerCase.session.outcome === "reply" ? 2 : 1);

    // `costUsd` is the reported-usage cost; a reply without usage is charged
    // a conservative char-based estimate on top, never recorded as free.
    const expectedCostUsd = providerCase.session.costUsd + (providerCase.session.estimatedUsage
      ? estimatedCostUsd(harness.provider.calls.at(-1), responses[scriptFor(providerCase).at(-1)])
      : 0);
    assert.equal(harness.estimatedUsage.length, providerCase.session.estimatedUsage ? 1 : 0);
    const { spentUsd } = await harness.Budget.canGenerate(harness.sessionId);
    assert.ok(
      Math.abs(spentUsd - expectedCostUsd) < 1e-12,
      `spent ${spentUsd}, expected ${expectedCostUsd}`
    );
    if (providerCase.session.estimatedUsage) assert.ok(spentUsd > 0);
    await harness.streamManager.closeAll();
  });
}
