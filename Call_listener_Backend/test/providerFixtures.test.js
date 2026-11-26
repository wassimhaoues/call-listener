import test from "node:test";
import assert from "node:assert/strict";
import { createAiReplyGenerator } from "../server/services/ai/aiService.js";
import { createFakeChatOpenRouter } from "./helpers/fakeProvider.js";
import { createReplayHarness } from "./helpers/replayHarness.js";
import { loadContexts, loadProviderResponses } from "./helpers/fixtures.js";

const contexts = loadContexts();
const { responses, cases } = loadProviderResponses();
const silentLog = { info() {}, error() {} };
const QUESTION = "How did you lead the migration?";

function createGenerator(responseName, requestTimeoutMs = 10_000) {
  const provider = createFakeChatOpenRouter({ responses, script: [responseName] });
  const generateReply = createAiReplyGenerator({
    provider: "openrouter",
    openRouterApiKey: "fixture-key-not-a-secret",
    openRouterModel: "fixture/model",
    openRouterMaxOutputTokens: 600,
    openRouterRequestTimeoutMs: requestTimeoutMs,
    log: silentLog,
    dependencies: { openrouter: { ChatOpenRouterClass: provider.ChatOpenRouterClass } },
  });
  return { provider, generateReply };
}

for (const providerCase of cases) {
  test(`OpenRouter adapter: ${providerCase.name}`, async () => {
    const { provider, generateReply } = createGenerator(providerCase.response, providerCase.requestTimeoutMs);
    const controller = new AbortController();
    const usage = [];
    const request = generateReply("system prompt", "caller: question", {
      signal: controller.signal,
      onUsage: (value) => usage.push(value ?? null),
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
    }
    assert.equal(provider.calls.length, 1, "the adapter never retries");
  });

  if (!providerCase.session) continue;

  test(`live session: ${providerCase.name} keeps transcription and reports the right outcome`, async () => {
    const harness = createReplayHarness({
      responses,
      contexts,
      providerScript: [providerCase.response],
      requestTimeoutMs: providerCase.requestTimeoutMs,
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

    const { spentUsd } = await harness.Budget.canGenerate(harness.sessionId);
    assert.ok(
      Math.abs(spentUsd - providerCase.session.costUsd) < 1e-12,
      `spent ${spentUsd}, expected ${providerCase.session.costUsd}`
    );
    await harness.streamManager.closeAll();
  });
}
