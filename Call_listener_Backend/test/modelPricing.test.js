import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import {
  MAX_PRICED_MODELS,
  MAX_USD_PER_MILLION_TOKENS,
  parseModelPrices,
  resolveModelPrices,
} from "../server/config/modelPrices.js";
import {
  createConfiguredPricing,
  createModelPricing,
  createSinglePricing,
  tokensCostUsd,
} from "../server/services/ai/modelPricing.js";
import { createInterviewBudget } from "../server/services/ai/interviewBudget.js";
import { createModelCatalog } from "../server/services/ai/modelCatalog.js";
import { createPreparationLimits } from "../server/services/preparation/preparationLimits.js";
import { createPreparationBriefService } from "../server/services/preparation/preparationBrief.js";
import { EvalConfigError, resolveProviderConfig, usageCost } from "../scripts/eval/lib/costGuard.js";
import { estimateRunCostUsd, planJobs } from "../scripts/eval/lib/harness.js";
import { loadFixtures } from "../scripts/eval/lib/fixtures.js";
import { createGraphVariant } from "../scripts/eval/lib/variants.js";
import { DEFAULT_FIXTURES_DIR, main } from "../scripts/eval/runEval.js";
import { createMemoryRedis } from "./helpers/memoryRedis.js";
import { sampleContext, validBrief } from "./helpers/preparationFixtures.js";

const execFileAsync = promisify(execFile);
const envModuleUrl = new URL("../server/config/env.js", import.meta.url).href;
const CHEAP = "openai/cheap";
const PRICEY = "anthropic/pricey";
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
const silentLog = { debug() {}, warn() {} };

function recordingLog() {
  const warnings = [];
  return { warnings, debug() {}, info() {}, warn: (message) => warnings.push(message) };
}

function twoModelPricing(log) {
  return createModelPricing({
    prices: new Map([
      [CHEAP, { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 }],
      [PRICEY, { inputUsdPerMillionTokens: 100, outputUsdPerMillionTokens: 200 }],
    ]),
    defaultModel: CHEAP,
    log,
  });
}

// --- configuration parsing ---------------------------------------------------

test("price table parses a bounded JSON object of input/output prices", () => {
  const prices = parseModelPrices(JSON.stringify({ [PRICEY]: { input: 3, output: 15 }, [CHEAP]: { input: 0, output: 0.5 } }));
  assert.ok(prices instanceof Map);
  assert.deepEqual(prices.get(PRICEY), { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 });
  assert.deepEqual(prices.get(CHEAP), { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0.5 });
  assert.equal(parseModelPrices(undefined).size, 0);
  assert.equal(parseModelPrices("  ").size, 0);
});

test("price table rejects malformed JSON, bad shapes, and out-of-range prices", () => {
  const rejects = (value, pattern) => assert.throws(() => parseModelPrices(value), pattern);
  rejects("{not json", /must be valid JSON/);
  rejects("[1,2]", /must be a JSON object/);
  rejects("42", /must be a JSON object/);
  rejects("null", /must be a JSON object/);
  rejects(JSON.stringify({ [PRICEY]: { input: -1, output: 1 } }), /input price for anthropic\/pricey/);
  rejects(JSON.stringify({ [PRICEY]: { input: 1, output: -0.01 } }), /output price/);
  rejects(JSON.stringify({ [PRICEY]: { input: "3", output: 15 } }), /input price/);
  rejects(JSON.stringify({ [PRICEY]: { input: 3 } }), /output price/);
  rejects(JSON.stringify({ [PRICEY]: { input: MAX_USD_PER_MILLION_TOKENS + 1, output: 1 } }), /from 0 to/);
  rejects(JSON.stringify({ [PRICEY]: { input: 1, output: 1, prompt: 2 } }), /accepts only input and output/);
  rejects(JSON.stringify({ [PRICEY]: [1, 2] }), /must be an object/);
  rejects(JSON.stringify({ "not a model": { input: 1, output: 1 } }), /invalid model ID/);
  rejects('{"__proto__": {"input": 1, "output": 1}}', /invalid model ID/);
  const tooMany = Object.fromEntries(
    Array.from({ length: MAX_PRICED_MODELS + 1 }, (_, index) => [`vendor/model-${index}`, { input: 1, output: 1 }])
  );
  rejects(JSON.stringify(tooMany), /at most 50 models/);
  rejects(`{"a/b": {"input": 1, "output": 1}, "pad": "${"x".repeat(17_000)}"}`, /at most 16384 characters/);
});

test("every allowlisted model needs a price; only the default may use the single pair", () => {
  const base = {
    allowedModels: [CHEAP, PRICEY],
    defaultModel: CHEAP,
    defaultInputUsdPerMillionTokens: 0.2,
    defaultOutputUsdPerMillionTokens: 1.2,
  };
  assert.throws(() => resolveModelPrices(base), /no price for allowlisted model\(s\): anthropic\/pricey/);

  const prices = resolveModelPrices({ ...base, value: JSON.stringify({ [PRICEY]: { input: 3, output: 15 } }) });
  assert.deepEqual(prices.get(CHEAP), { inputUsdPerMillionTokens: 0.2, outputUsdPerMillionTokens: 1.2 });
  assert.deepEqual(prices.get(PRICEY), { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 });

  // A table entry for the default model wins over the single pair.
  const overridden = resolveModelPrices({ ...base, value: JSON.stringify({ [CHEAP]: { input: 1, output: 2 }, [PRICEY]: { input: 3, output: 15 } }) });
  assert.deepEqual(overridden.get(CHEAP), { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 });

  // Groq mode parses the table but does not require allowlist coverage.
  assert.equal(resolveModelPrices({ ...base, requireAll: false }).has(PRICEY), false);
});

const baseEnv = {
  PATH: process.env.PATH,
  AI_PROVIDER: "openrouter",
  OPENROUTER_API_KEY: "test-openrouter-key",
  DEEPGRAM_API_KEY: "test-deepgram-key",
  REDIS_URL: "redis://127.0.0.1:6379",
  APP_ID: "com.coworky.calllistener",
  JWT_SECRET: "test-jwt-secret",
  JWT_TTL_SECONDS: "900",
};

function loadPrices(env) {
  return execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { CONFIG } from ${JSON.stringify(envModuleUrl)}; ` +
        "process.stdout.write(JSON.stringify(Object.fromEntries(CONFIG.OPENROUTER_MODEL_PRICES)));",
    ],
    { cwd: os.tmpdir(), env: { ...baseEnv, ...env } }
  );
}

test("startup keeps the single-price variables working for the default model", async () => {
  const { stdout } = await loadPrices({
    OPENROUTER_MODEL: CHEAP,
    OPENROUTER_INPUT_USD_PER_MILLION_TOKENS: "0.4",
    OPENROUTER_OUTPUT_USD_PER_MILLION_TOKENS: "1.6",
  });
  assert.deepEqual(JSON.parse(stdout), { [CHEAP]: { inputUsdPerMillionTokens: 0.4, outputUsdPerMillionTokens: 1.6 } });
});

test("startup fails clearly for an unpriced allowlisted model or a malformed table", async () => {
  await assert.rejects(
    loadPrices({ OPENROUTER_MODEL: CHEAP, OPENROUTER_ALLOWED_MODELS: `${CHEAP},${PRICEY}` }),
    (error) => /no price for allowlisted model\(s\): anthropic\/pricey/.test(error.stderr)
  );
  await assert.rejects(
    loadPrices({ OPENROUTER_MODEL: CHEAP, OPENROUTER_MODEL_PRICES: "{oops" }),
    (error) => /OPENROUTER_MODEL_PRICES must be valid JSON/.test(error.stderr) && !error.stderr.includes("{oops")
  );
  await assert.rejects(
    loadPrices({ OPENROUTER_MODEL: CHEAP, OPENROUTER_MODEL_PRICES: JSON.stringify({ [CHEAP]: { input: -1, output: 1 } }) }),
    (error) => /input price for openai\/cheap/.test(error.stderr)
  );

  const { stdout } = await loadPrices({
    OPENROUTER_MODEL: CHEAP,
    OPENROUTER_ALLOWED_MODELS: `${CHEAP},${PRICEY}`,
    OPENROUTER_MODEL_PRICES: JSON.stringify({ [PRICEY]: { input: 3, output: 15 } }),
  });
  assert.deepEqual(JSON.parse(stdout)[PRICEY], { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 });

  // Groq mode does not bill OpenRouter models, so coverage is not required.
  await loadPrices({
    AI_PROVIDER: "groq",
    GROQ_API_KEY: "test-groq-key",
    OPENROUTER_MODEL: CHEAP,
    OPENROUTER_ALLOWED_MODELS: `${CHEAP},${PRICEY}`,
  });
});

// --- pricing module ------------------------------------------------------------

test("priceFor and resolve fall back from the served model to the selection to the default", () => {
  const log = recordingLog();
  const pricing = twoModelPricing(log);
  assert.equal(pricing.priceFor(PRICEY).inputUsdPerMillionTokens, 100);
  assert.equal(pricing.priceFor("unknown/model").model, CHEAP);
  assert.equal(pricing.priceFor(undefined).model, CHEAP);
  assert.equal(pricing.priceFor("constructor").model, CHEAP, "no inherited property lookups");

  assert.equal(pricing.resolve({ model: CHEAP, actualModel: PRICEY }).model, PRICEY, "the served model wins");
  assert.equal(pricing.resolve({ model: PRICEY, actualModel: null }).model, PRICEY);
  assert.equal(pricing.resolve({ model: PRICEY, actualModel: "anthropic/pricey-2026" }).model, PRICEY);
  assert.equal(pricing.resolve({}).model, CHEAP);
  assert.equal(pricing.resolve(undefined).model, CHEAP);
  assert.equal(log.warnings.length, 1, "an unpriced served model is reported once");
  pricing.resolve({ model: PRICEY, actualModel: "anthropic/pricey-2026" });
  assert.equal(log.warnings.length, 1);

  assert.throws(() => createModelPricing({ prices: {}, defaultModel: CHEAP }), /default model must have a price/);
  assert.throws(
    () => createModelPricing({ prices: { [CHEAP]: { inputUsdPerMillionTokens: -1, outputUsdPerMillionTokens: 0 } }, defaultModel: CHEAP }),
    /non-negative/
  );
  close(tokensCostUsd(pricing.priceFor(PRICEY), 1_000, 500), 0.2);
});

test("configured pricing uses the table and the single pair for the default model", () => {
  const pricing = createConfiguredPricing({
    OPENROUTER_MODEL: CHEAP,
    OPENROUTER_INPUT_USD_PER_MILLION_TOKENS: 0.2,
    OPENROUTER_OUTPUT_USD_PER_MILLION_TOKENS: 1.2,
    OPENROUTER_MODEL_PRICES: new Map([[PRICEY, { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 }]]),
  });
  assert.equal(pricing.priceFor(CHEAP).outputUsdPerMillionTokens, 1.2);
  assert.equal(pricing.priceFor(PRICEY).outputUsdPerMillionTokens, 15);
  // A config without a table (older test configs) still prices the default.
  const legacy = createConfiguredPricing({ OPENROUTER_MODEL: CHEAP, OPENROUTER_INPUT_USD_PER_MILLION_TOKENS: 1, OPENROUTER_OUTPUT_USD_PER_MILLION_TOKENS: 2 });
  assert.equal(legacy.priceFor(PRICEY).model, CHEAP);
});

// --- interview budget ------------------------------------------------------------

test("the interview budget charges each reply at the price of the model that served it", async () => {
  const budget = createInterviewBudget({ redisClient: createMemoryRedis(), maxUsd: 1, pricing: twoModelPricing(silentLog), log: silentLog });
  const usage = { input_tokens: 1_000, output_tokens: 500 };

  const cheap = await budget.recordUsage("s1", usage, { model: CHEAP, actualModel: CHEAP });
  close(cheap.costUsd, (1_000 * 1 + 500 * 2) / 1_000_000);
  assert.equal(cheap.model, CHEAP);

  const pricey = await budget.recordUsage("s1", usage, { model: PRICEY, actualModel: null });
  close(pricey.costUsd, (1_000 * 100 + 500 * 200) / 1_000_000);
  assert.equal(pricey.model, PRICEY);
  close(pricey.spentUsd, cheap.costUsd + pricey.costUsd);

  // An unknown or missing model is charged at the default model's price.
  const unknown = await budget.recordUsage("s1", usage, { model: "other/model" });
  close(unknown.costUsd, cheap.costUsd);
  const missing = await budget.recordUsage("s1", usage);
  close(missing.costUsd, cheap.costUsd);
});

test("the pricey model exhausts the interview budget the cheap one would not", async () => {
  const budget = createInterviewBudget({ redisClient: createMemoryRedis(), maxUsd: 0.05, pricing: twoModelPricing(silentLog), log: silentLog });
  const usage = { input_tokens: 1_000, output_tokens: 500 };
  assert.equal((await budget.recordUsage("cheap", usage, { model: CHEAP })).exhausted, false);
  assert.equal((await budget.recordUsage("pricey", usage, { model: PRICEY })).exhausted, true);
  assert.equal((await budget.canGenerate("pricey")).allowed, false);
  assert.equal((await budget.canGenerate("cheap")).allowed, true);
});

test("the interview budget still accepts one price pair (backward compatible)", async () => {
  const budget = createInterviewBudget({
    redisClient: createMemoryRedis(),
    maxUsd: 1,
    inputUsdPerMillionTokens: 0.2,
    outputUsdPerMillionTokens: 1.2,
    log: silentLog,
  });
  const result = await budget.recordUsage("s1", { input_tokens: 1_000, output_tokens: 500 }, { model: PRICEY });
  close(result.costUsd, 0.0008);
  assert.throws(
    () => createInterviewBudget({ redisClient: {}, maxUsd: 1, pricing: {} }),
    /pricing must come from createModelPricing/
  );
  assert.throws(() => createSinglePricing({ inputUsdPerMillionTokens: -1, outputUsdPerMillionTokens: 1 }), /non-negative/);
});

// --- preparation reservation ----------------------------------------------------------

function prepLimits(redisClient, dailyBudgetUsd = 0.01) {
  return createPreparationLimits({
    redisClient,
    dailyBudgetUsd,
    pricing: twoModelPricing(silentLog),
    maxRequestsPerMinute: 10,
    maxOutputTokens: 10,
  });
}

test("preparation reserves the worst case at the selected model's price", async () => {
  const redisClient = createMemoryRedis();
  const limits = prepLimits(redisClient);
  // ceil(40 / 4) = 10 input tokens + 10 output tokens.
  const cheap = await limits.reserve("device-a", { inputChars: 40, model: CHEAP });
  close(cheap.reservedUsd, (10 * 1 + 10 * 2) / 1_000_000);
  assert.equal(cheap.model, CHEAP);
  await limits.release(cheap);

  const pricey = await limits.reserve("device-a", { inputChars: 40, model: PRICEY });
  close(pricey.reservedUsd, (10 * 100 + 10 * 200) / 1_000_000);
  await limits.release(pricey);

  // A $0.00003 budget fits the cheap worst case but refuses the pricey one.
  const tight = prepLimits(createMemoryRedis(), 0.00003);
  assert.equal(await tight.reserve("device-b", { inputChars: 40, model: PRICEY }), null);
  assert.ok(await tight.reserve("device-b", { inputChars: 40, model: CHEAP }));
  // An unpriced selection reserves at the default model's price.
  close((await prepLimits(createMemoryRedis()).reserve("d", { inputChars: 40, model: "other/model" })).reservedUsd, cheap.reservedUsd);
});

test("preparation settles a reservation at the served model's price", async () => {
  const redisClient = createMemoryRedis();
  const limits = prepLimits(redisClient, 1);
  const reservation = await limits.reserve("device-a", { inputChars: 40, model: PRICEY });
  const settled = await limits.recordUsage(
    "device-a",
    { input_tokens: 5, output_tokens: 5 },
    { model: PRICEY, actualModel: null },
    reservation
  );
  close(settled.costUsd, (5 * 100 + 5 * 200) / 1_000_000);
  close(settled.spentUsd, settled.costUsd);
  assert.equal(settled.model, PRICEY);
});

test("the preparation service reserves and charges with the requested model", async () => {
  const calls = { reserve: [], record: [] };
  const service = createPreparationBriefService({
    generateReply: async (system, user, options) => {
      // An adapter that omits model IDs: the service falls back to the selection.
      await options.onUsage({ input_tokens: 10, output_tokens: 5 }, { inputChars: 1, outputChars: 1 });
      return JSON.stringify(validBrief());
    },
    limits: {
      takeRateToken: async () => true,
      canSpend: async () => true,
      reserve: async (deviceId, basis) => {
        calls.reserve.push(basis);
        return { key: "k", reservedUsd: 0 };
      },
      release: async () => {},
      recordUsage: async (deviceId, usage, basis) => calls.record.push(basis),
    },
    isModelAllowed: () => true,
  });
  await service.generate({ context: sampleContext(), model: PRICEY }, { deviceId: "device-a" });
  assert.equal(calls.reserve[0].model, PRICEY);
  assert.equal(calls.record[0].model, PRICEY);
});

// --- evaluation cost guard -------------------------------------------------------------

const LIVE_ENV = Object.freeze({
  OPENROUTER_API_KEY: "sk-or-test-not-a-real-key",
  OPENROUTER_MODEL: CHEAP,
  OPENROUTER_ALLOWED_MODELS: `${CHEAP},${PRICEY}`,
  OPENROUTER_MODEL_PRICES: JSON.stringify({ [PRICEY]: { input: 100, output: 200 } }),
});

test("the eval guard caps a live run with the selected model's own price", async () => {
  const pricey = resolveProviderConfig({ provider: "openrouter", live: true, maxUsd: "1", model: PRICEY }, LIVE_ENV);
  assert.deepEqual(pricey.prices, { inputUsdPerMillion: 100, outputUsdPerMillion: 200 });
  const cheap = resolveProviderConfig({ provider: "openrouter", live: true, maxUsd: "1" }, LIVE_ENV);
  assert.deepEqual(cheap.prices, { inputUsdPerMillion: 0.2, outputUsdPerMillion: 1.2 }, "single pair for the default");

  const { cases } = await loadFixtures(DEFAULT_FIXTURES_DIR);
  const jobs = planJobs(cases, [createGraphVariant()]);
  assert.ok(estimateRunCostUsd(jobs, pricey) > estimateRunCostUsd(jobs, cheap) * 100);

  // A served model in the table is charged at its own price.
  const served = usageCost({
    usage: { input_tokens: 1_000, output_tokens: 0 },
    basis: { model: CHEAP, actualModel: PRICEY },
    prices: cheap.prices,
    pricing: cheap.pricing,
  });
  close(served.costUsd, 0.1);
});

test("the eval guard refuses an unpriced selected model and a malformed table", () => {
  const refuses = (options, env, pattern) => assert.throws(() => resolveProviderConfig(options, env), (error) =>
    error instanceof EvalConfigError && pattern.test(error.message));
  refuses(
    { provider: "openrouter", live: true, maxUsd: "1", model: PRICEY },
    { ...LIVE_ENV, OPENROUTER_MODEL_PRICES: "" },
    /no price for allowlisted model\(s\): anthropic\/pricey/
  );
  refuses(
    { provider: "openrouter", live: true, maxUsd: "1", model: PRICEY },
    { ...LIVE_ENV, OPENROUTER_MODEL_PRICES: JSON.stringify({ [PRICEY]: { input: 0, output: 1 } }) },
    /must be positive/
  );
  refuses({ provider: "fake" }, { OPENROUTER_MODEL_PRICES: "{bad" }, /must be valid JSON/);
});

test("the eval CLI refuses a pricey model whose worst case passes the cap", async () => {
  let constructed = 0;
  class FakeChatOpenRouter {
    constructor() {
      constructed += 1;
    }

    async invoke() {
      throw new Error("no request may be sent");
    }
  }
  const errors = [];
  const code = await main(["--provider", "openrouter", "--live", "--max-usd", "0.5", "--model", PRICEY], {
    env: LIVE_ENV, write: () => {}, writeError: (text) => errors.push(text), ChatOpenRouterClass: FakeChatOpenRouter, outDir: os.tmpdir(),
  });
  assert.equal(code, 2);
  assert.match(errors.join(""), /no request was sent/);
  assert.ok(constructed <= 1, "the adapter may be built but is never called");
});

// --- catalog cross-check ---------------------------------------------------------------

test("a configured price below OpenRouter's catalog price logs one warning; catalog prices are never billed", async () => {
  const log = recordingLog();
  const pricing = twoModelPricing(log);
  const catalog = createModelCatalog({
    allowedModels: [CHEAP, PRICEY],
    defaultModel: CHEAP,
    ttlMs: 0,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          // $1 / $2 per million matches the table: no warning.
          { id: CHEAP, pricing: { prompt: "0.000001", completion: "0.000002" } },
          // $150 input per million is above the configured $100.
          { id: PRICEY, pricing: { prompt: "0.00015", completion: "0.0002" } },
        ],
      }),
    }),
    onRefresh: (models) => pricing.warnIfBelowCatalog(models),
    log,
  });
  await catalog.getCatalog();
  assert.equal(log.warnings.length, 1);
  assert.match(log.warnings[0], /anthropic\/pricey .*lower than OpenRouter's catalog/);
  await catalog.getCatalog();
  assert.equal(log.warnings.length, 1, "the same catalog price is reported once");
  // Billing keeps the configured price.
  assert.equal(pricing.priceFor(PRICEY).inputUsdPerMillionTokens, 100);
  assert.deepEqual(pricing.findUnderpriced([{ id: CHEAP, pricing: { inputUsdPerMillionTokens: 0.5, outputUsdPerMillionTokens: null } }]), []);
});

test("a throwing refresh observer never breaks the catalog", async () => {
  const log = recordingLog();
  const catalog = createModelCatalog({
    allowedModels: [CHEAP],
    defaultModel: CHEAP,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: CHEAP }] }) }),
    onRefresh: () => {
      throw new Error("observer bug");
    },
    log,
  });
  const snapshot = await catalog.getCatalog();
  assert.equal(snapshot.source, "openrouter");
  assert.match(log.warnings[0], /observer failed/);
});
