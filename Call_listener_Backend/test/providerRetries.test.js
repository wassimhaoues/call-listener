import test from "node:test";
import assert from "node:assert/strict";
import { createOpenRouterReplyGenerator, retryAfterMs } from "../server/services/ai/openRouterService.js";
import { createInterviewBudget } from "../server/services/ai/interviewBudget.js";
import { createFakeChatOpenRouter } from "./helpers/fakeProvider.js";
import { createMemoryRedis } from "./helpers/memoryRedis.js";
import { loadProviderResponses } from "./helpers/fixtures.js";

const { responses } = loadProviderResponses();
// Production retry rules without the real backoff wait, unless a test sets it.
const FAST_RETRIES = { minDelayMs: 0, maxDelayMs: 0, minAttemptMs: 0 };

function recordingLog() {
  const lines = [];
  const record = (level) => (message, ...args) => lines.push({ level, message, args });
  return { lines, info: record("info"), warn: record("warn"), error: record("error") };
}

function setup({
  script = [],
  failFirst,
  maxRetries = 1,
  retryPolicy = FAST_RETRIES,
  requestTimeoutMs = 10_000,
  log = recordingLog(),
} = {}) {
  const provider = createFakeChatOpenRouter({ responses, script, failFirst });
  const generateReply = createOpenRouterReplyGenerator({
    apiKey: "fixture-key-not-a-secret",
    model: "fixture/model",
    maxOutputTokens: 600,
    requestTimeoutMs,
    maxRetries,
    retryPolicy,
    ChatOpenRouterClass: provider.ChatOpenRouterClass,
    log,
  });
  return { provider, generateReply, log };
}

function collectingOptions(extra = {}) {
  const usage = [];
  return {
    usage,
    options: {
      onUsage: (value, basis) => usage.push([value ?? null, basis]),
      ...extra,
    },
  };
}

function rejectsWith(code, status) {
  return (error) => {
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.cause?.status, status);
    return true;
  };
}

async function until(predicate) {
  while (!predicate()) await new Promise((resolve) => setImmediate(resolve));
}

test("LangChain's own retries are disabled so the adapter policy is the only one", () => {
  const { provider } = setup();
  assert.equal(provider.instances.length, 1);
  assert.equal(provider.instances[0].maxRetries, 0);
});

test("a 429 is retried once and the successful attempt is charged", async () => {
  const { provider, generateReply, log } = setup({ script: ["rateLimited", "migrationAnswer"] });
  const { usage, options } = collectingOptions();
  const text = await generateReply("system", "history", options);
  assert.match(text, /zero data loss/);
  assert.equal(provider.calls.length, 2);
  assert.equal(usage.length, 1, "only the attempt that produced a completion is charged");
  assert.deepEqual(usage[0][0], responses.migrationAnswer.usage_metadata);
  assert.equal(usage[0][1].attempts, 2);

  const warnings = log.lines.filter((line) => line.level === "warn");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /attempt 1 failed \(status 429\); retrying in 0 ms/);
  assert.doesNotMatch(warnings[0].message, /Rate limit exceeded/, "attempt logs carry the code, not provider text");
});

test("503 then 503 fails after the configured maximum", async () => {
  const { provider, generateReply } = setup({ failFirst: { times: 5, error: { status: 503 } } });
  const { usage, options } = collectingOptions();
  await assert.rejects(generateReply("s", "h", options), rejectsWith("provider_request_failed", 503));
  assert.equal(provider.calls.length, 2, "one retry by default");
  assert.deepEqual(usage, [], "failed attempts without usage are not charged");
});

test("OPENROUTER_MAX_RETRIES bounds the attempts between one and three", async () => {
  for (const [maxRetries, calls] of [[0, 1], [2, 3]]) {
    const { provider, generateReply } = setup({ maxRetries, failFirst: { times: 5, error: { status: 502 } } });
    await assert.rejects(generateReply("s", "h"), rejectsWith("provider_request_failed", 502));
    assert.equal(provider.calls.length, calls, `maxRetries ${maxRetries}`);
  }
  for (const maxRetries of [3, -1, 1.5, "1"]) {
    assert.throws(() => setup({ maxRetries }), /maxRetries must be an integer between 0 and 2/);
  }
  assert.throws(
    () => setup({ retryPolicy: { minDelayMs: 500, maxDelayMs: 100 } }),
    /maxDelayMs must not be below minDelayMs/
  );
});

test("permanent failures (invalid key, removed model, unsupported parameters) are not retried", async () => {
  for (const [name, status] of [["invalidKey", 401], ["removedModel", 404], ["unsupportedParams", 400]]) {
    for (const streaming of [false, true]) {
      const { provider, generateReply } = setup({ script: [name, "migrationAnswer"] });
      const options = streaming ? { onToken() {} } : {};
      await assert.rejects(generateReply("s", "h", options), rejectsWith("provider_request_failed", status));
      assert.equal(provider.calls.length, 1, `${name} (${streaming ? "stream" : "invoke"})`);
    }
  }
});

test("connection failures before the request are retried; a reset connection is not", async () => {
  const refused = setup({ script: ["connectionRefused", "introSuccess"] });
  assert.match(await refused.generateReply("s", "h"), /billing migration/);
  assert.equal(refused.provider.calls.length, 2);
  assert.match(refused.log.lines.find((line) => line.level === "warn").message, /\(ECONNREFUSED\)/);

  const reset = setup({ script: ["connectionReset", "introSuccess"] });
  await assert.rejects(reset.generateReply("s", "h"), rejectsWith("provider_request_failed"));
  assert.equal(reset.provider.calls.length, 1, "the provider may already be generating after a reset");
});

test("an abort during the backoff wait stops immediately without another attempt", async () => {
  const { provider, generateReply } = setup({
    script: ["serviceUnavailable", "migrationAnswer"],
    retryPolicy: { minDelayMs: 5_000, maxDelayMs: 5_000, minAttemptMs: 0 },
  });
  const controller = new AbortController();
  const startedAt = Date.now();
  const request = generateReply("s", "h", { signal: controller.signal });
  await until(() => provider.calls[0]?.status === "rejected");
  controller.abort(new Error("superseded"));
  await assert.rejects(request, rejectsWith("provider_aborted"));
  assert.ok(Date.now() - startedAt < 2_000, "the 5-second backoff was not waited out");
  assert.equal(provider.calls.length, 1);
});

test("an already-aborted request is never retried", async () => {
  const { provider, generateReply } = setup({ script: ["hangUntilAborted", "migrationAnswer"] });
  const controller = new AbortController();
  const request = generateReply("s", "h", { signal: controller.signal });
  await until(() => provider.pendingCount() === 1);
  controller.abort(new Error("session closed"));
  await assert.rejects(request, rejectsWith("provider_aborted"));
  assert.equal(provider.calls.length, 1);
});

test("no retry is sent when the remaining deadline cannot fit the wait and an attempt", async () => {
  const { provider, generateReply } = setup({
    script: ["serviceUnavailable", "migrationAnswer"],
    requestTimeoutMs: 300,
    retryPolicy: { minDelayMs: 200, maxDelayMs: 200, minAttemptMs: 200 },
  });
  const startedAt = Date.now();
  await assert.rejects(generateReply("s", "h"), rejectsWith("provider_request_failed", 503));
  assert.ok(Date.now() - startedAt < 200, "the failure surfaces at once instead of waiting");
  assert.equal(provider.calls.length, 1);
});

test("a retry shares the original deadline and never extends it", async () => {
  const { provider, generateReply } = setup({
    script: ["serviceUnavailable", "hangUntilAborted"],
    requestTimeoutMs: 120,
  });
  const startedAt = Date.now();
  await assert.rejects(generateReply("s", "h"), rejectsWith("provider_timeout"));
  const elapsed = Date.now() - startedAt;
  assert.equal(provider.calls.length, 2);
  assert.ok(elapsed < 230, `timed out after ${elapsed} ms, within one request deadline`);
});

test("a streaming failure before the first token is retried and only the retry streams", async () => {
  const { provider, generateReply } = setup({
    script: ["streamedAnswer"],
    failFirst: { times: 1, error: { status: 503 } },
  });
  const tokens = [];
  const { usage, options } = collectingOptions({ onToken: (delta) => tokens.push(delta) });
  const text = await generateReply("s", "h", options);
  assert.equal(provider.calls.length, 2);
  assert.deepEqual(tokens, responses.streamedAnswer.chunks);
  assert.equal(text, responses.streamedAnswer.chunks.join("").trim());
  assert.equal(usage.length, 1);
  assert.equal(usage[0][1].attempts, 2);
});

test("a streaming failure after the first token is not retried (no restart mid-answer)", async () => {
  const { provider, generateReply } = setup({ script: ["streamThenBadGateway", "streamedAnswer"] });
  const tokens = [];
  const { usage, options } = collectingOptions({ onToken: (delta) => tokens.push(delta) });
  await assert.rejects(generateReply("s", "h", options), rejectsWith("provider_request_failed", 502));
  assert.equal(provider.calls.length, 1);
  assert.deepEqual(tokens, ["Partial answer that "], "no second answer is streamed after the partial one");
  assert.deepEqual(usage, []);
});

test("Retry-After is honoured when it fits the deadline", async () => {
  const { provider, generateReply, log } = setup({ script: ["rateLimitedRetryAfter", "migrationAnswer"] });
  const startedAt = Date.now();
  await generateReply("s", "h");
  assert.ok(Date.now() - startedAt >= 55, "waited for the 60 ms Retry-After");
  assert.equal(provider.calls.length, 2);
  assert.match(log.lines.find((line) => line.level === "warn").message, /retrying in 60 ms/);
});

test("a Retry-After beyond the remaining deadline fails at once instead of waiting", async () => {
  const { provider, generateReply } = setup({ script: ["rateLimitedLongRetryAfter", "migrationAnswer"] });
  const startedAt = Date.now();
  await assert.rejects(generateReply("s", "h"), rejectsWith("provider_request_failed", 429));
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(provider.calls.length, 1);
});

test("Retry-After parsing accepts seconds and HTTP dates", () => {
  const now = Date.parse("2026-11-26T10:00:00Z");
  assert.equal(retryAfterMs({ headers: { "retry-after": "2" } }, now), 2_000);
  assert.equal(retryAfterMs({ headers: { "retry-after": "0.25" } }, now), 250);
  assert.equal(retryAfterMs({ headers: new Headers({ "Retry-After": "Thu, 26 Nov 2026 10:00:03 GMT" }) }, now), 3_000);
  assert.equal(retryAfterMs({ headers: { "retry-after": "Thu, 26 Nov 2026 09:00:00 GMT" } }, now), 0);
  assert.equal(retryAfterMs({ headers: { "retry-after": "soon" } }, now), null);
  assert.equal(retryAfterMs({ headers: {} }, now), null);
  assert.equal(retryAfterMs({}, now), null);
});

test("the budget is charged for every attempt that reports usage, once each", async () => {
  const budget = createInterviewBudget({
    redisClient: createMemoryRedis(),
    maxUsd: 5,
    inputUsdPerMillionTokens: 1,
    outputUsdPerMillionTokens: 1,
    log: { warn() {}, debug() {} },
  });
  const charge = (sessionId) => (usage, basis) => budget.recordUsage(sessionId, usage, basis);

  // A retried 503 reported nothing, so only the completed attempt is charged.
  const retried = setup({ script: ["serviceUnavailable", "migrationAnswer"] });
  await retried.generateReply("s", "h", { onUsage: charge("retried") });
  assert.equal((await budget.canGenerate("retried")).spentUsd, 1_350 / 1e6);

  // A stream that reported usage and then failed was billed: it is charged
  // and, because it was billed, never retried.
  const billed = setup({ script: ["usageThenServiceUnavailable", "streamedAnswer"] });
  const { usage, options } = collectingOptions({ onToken() {} });
  await assert.rejects(
    billed.generateReply("s", "h", { ...options, onUsage: async (value, basis) => {
      options.onUsage(value, basis);
      await charge("billed")(value, basis);
    } }),
    rejectsWith("provider_request_failed", 503)
  );
  assert.equal(billed.provider.calls.length, 1);
  assert.deepEqual(usage, [[
    responses.usageThenServiceUnavailable.usage_metadata,
    { inputChars: 2, outputChars: 0, model: "fixture/model", actualModel: null, attempts: 1 },
  ]]);
  assert.equal((await budget.canGenerate("billed")).spentUsd, 900 / 1e6);
});

test("an accounting failure after a provider error keeps the provider error", async () => {
  const { generateReply, log } = setup({ script: ["usageThenServiceUnavailable"] });
  await assert.rejects(
    generateReply("s", "h", { onToken() {}, onUsage: () => { throw new Error("redis down"); } }),
    rejectsWith("provider_request_failed", 503)
  );
  assert.ok(log.lines.some((line) => line.level === "error" && /usage accounting failed/.test(line.message)));
});
