import test from "node:test";
import assert from "node:assert/strict";
import { createInterviewBudget } from "../server/services/ai/interviewBudget.js";

function createRedis() {
  const values = new Map();
  return {
    async hget(key, field) { return values.get(key)?.[field] || null; },
    async hset(key, fields) { values.set(key, { ...(values.get(key) || {}), ...fields }); },
    async hincrbyfloat(key, field, delta) {
      const hash = { ...(values.get(key) || {}) };
      hash[field] = String(Number(hash[field] || 0) + delta);
      values.set(key, hash);
      return hash[field];
    },
    async hincrby(key, field, delta) {
      const hash = { ...(values.get(key) || {}) };
      hash[field] = String(Number(hash[field] || 0) + delta);
      values.set(key, hash);
      return Number(hash[field]);
    },
    async expire() {},
    async del(key) { values.delete(key); },
  };
}

test("records OpenRouter token usage and blocks the next generation at the interview ceiling", async () => {
  const budget = createInterviewBudget({
    redisClient: createRedis(),
    maxUsd: 0.001,
    inputUsdPerMillionTokens: 0.2,
    outputUsdPerMillionTokens: 1.2,
    log: { debug() {} },
  });

  assert.deepEqual(await budget.canGenerate("session-1"), {
    allowed: true,
    spentUsd: 0,
    maxUsd: 0.001,
    calls: 0,
  });
  const first = await budget.recordUsage("session-1", {
    input_tokens: 1_000,
    output_tokens: 500,
  });
  assert.equal(first.costUsd, 0.0008);
  assert.equal(first.exhausted, false);

  const second = await budget.recordUsage("session-1", {
    input_tokens: 1_000,
    output_tokens: 500,
  });
  assert.equal(second.spentUsd, 0.0016);
  assert.equal(second.exhausted, true);
  assert.equal((await budget.canGenerate("session-1")).allowed, false);
});

test("rejects invalid budget configuration and usage values", async () => {
  assert.throws(
    () => createInterviewBudget({ redisClient: {}, maxUsd: -1, inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 }),
    /maxUsd/
  );
  const budget = createInterviewBudget({
    redisClient: createRedis(),
    maxUsd: 1,
    inputUsdPerMillionTokens: 0.2,
    outputUsdPerMillionTokens: 1.2,
    log: { debug() {} },
  });
  await assert.rejects(
    budget.recordUsage("session-1", { input_tokens: -1, output_tokens: 0 }),
    /usage token counts/
  );
});

test("charges a conservative estimate and warns when the provider reports no usage", async () => {
  const warnings = [];
  const budget = createInterviewBudget({
    redisClient: createRedis(),
    maxUsd: 1,
    inputUsdPerMillionTokens: 0.2,
    outputUsdPerMillionTokens: 1.2,
    log: { debug() {}, warn: (message) => warnings.push(message) },
  });

  const result = await budget.recordUsage("session-1", undefined, { inputChars: 4_001, outputChars: 400 });
  // ceil(4001 / 4) = 1001 input tokens, ceil(400 / 4) = 100 output tokens.
  assert.equal(result.estimated, true);
  assert.ok(Math.abs(result.costUsd - (1001 * 0.2 + 100 * 1.2) / 1_000_000) < 1e-15);
  assert.ok(result.costUsd > 0, "missing usage is never recorded as free");
  assert.equal((await budget.canGenerate("session-1")).spentUsd, result.costUsd);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no usage/);
  assert.match(warnings[0], /1001 input \/ 100 output/);
});

test("estimates only the token count the provider omitted", async () => {
  const warnings = [];
  const budget = createInterviewBudget({
    redisClient: createRedis(),
    maxUsd: 1,
    inputUsdPerMillionTokens: 0.2,
    outputUsdPerMillionTokens: 1.2,
    log: { debug() {}, warn: (message) => warnings.push(message) },
  });

  const partial = await budget.recordUsage("session-1", { prompt_tokens: 1_000 }, { inputChars: 99_999, outputChars: 40 });
  assert.equal(partial.estimated, true);
  assert.ok(Math.abs(partial.costUsd - (1000 * 0.2 + 10 * 1.2) / 1_000_000) < 1e-15);
  assert.match(warnings[0], /no output usage/);

  const reported = await budget.recordUsage("session-1", { input_tokens: 10, output_tokens: 0 }, { inputChars: 4_000, outputChars: 4_000 });
  assert.equal(reported.estimated, false, "a reported zero is not replaced by an estimate");
  assert.ok(Math.abs(reported.costUsd - (10 * 0.2) / 1_000_000) < 1e-15);
  assert.equal(warnings.length, 1);
});

test("maxCalls stops generation after that many charged model calls", async () => {
  const budget = createInterviewBudget({
    redisClient: createRedis(),
    maxUsd: 100,
    maxCalls: 2,
    inputUsdPerMillionTokens: 0,
    outputUsdPerMillionTokens: 0,
    log: { debug() {}, warn() {} },
  });
  const first = await budget.recordUsage("s", { input_tokens: 10, output_tokens: 10 });
  assert.equal(first.exhausted, false);
  assert.equal((await budget.canGenerate("s")).allowed, true);
  const second = await budget.recordUsage("s", { input_tokens: 10, output_tokens: 10 });
  assert.equal(second.calls, 2);
  assert.equal(second.exhausted, true);
  assert.deepEqual(await budget.canGenerate("s"), { allowed: false, spentUsd: 0, maxUsd: 100, calls: 2 });
  assert.throws(
    () => createInterviewBudget({ redisClient: createRedis(), maxUsd: 1, maxCalls: 0, inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 }),
    /maxCalls/
  );
});

test("concurrent charges for one session are all counted", async () => {
  const budget = createInterviewBudget({
    redisClient: createRedis(),
    maxUsd: 100,
    inputUsdPerMillionTokens: 1_000_000,
    outputUsdPerMillionTokens: 0,
    log: { debug() {}, warn() {} },
  });
  await Promise.all([1, 2, 3, 4].map(() => budget.recordUsage("s", { input_tokens: 1, output_tokens: 0 })));
  const { spentUsd, calls } = await budget.canGenerate("s");
  assert.equal(spentUsd, 4);
  assert.equal(calls, 4);
});
