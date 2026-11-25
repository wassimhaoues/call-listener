import test from "node:test";
import assert from "node:assert/strict";
import { createInterviewBudget } from "../server/services/ai/interviewBudget.js";

function createRedis() {
  const values = new Map();
  return {
    async hget(key, field) { return values.get(key)?.[field] || null; },
    async hset(key, fields) { values.set(key, { ...(values.get(key) || {}), ...fields }); },
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
