import test from "node:test";
import assert from "node:assert/strict";
import { createModelCatalog } from "../server/services/ai/modelCatalog.js";
import { parseModelAllowlist } from "../server/config/modelAllowlist.js";

const silentLog = { warn() {} };
const allowedModels = ["openai/gpt-5.6-luna", "anthropic/claude-test", "removed/model"];

function upstreamResponse(data) {
  return { ok: true, status: 200, json: async () => ({ data }) };
}

const upstreamModels = [
  {
    id: "openai/gpt-5.6-luna",
    name: "Luna",
    context_length: 128_000,
    pricing: { prompt: "0.0000002", completion: "0.0000012" },
  },
  { id: "anthropic/claude-test", name: "Claude Test", context_length: 200_000 },
  { id: "not/allowlisted", name: "Never shown" },
];

test("allowlist defaults to the configured model and must include it", () => {
  assert.deepEqual(parseModelAllowlist("", "openai/gpt-5.6-luna"), ["openai/gpt-5.6-luna"]);
  assert.deepEqual(
    parseModelAllowlist(" openai/gpt-5.6-luna, anthropic/claude-test ,openai/gpt-5.6-luna", "openai/gpt-5.6-luna"),
    ["openai/gpt-5.6-luna", "anthropic/claude-test"]
  );
  assert.throws(
    () => parseModelAllowlist("anthropic/claude-test", "openai/gpt-5.6-luna"),
    /must include OPENROUTER_MODEL/
  );
  assert.throws(
    () => parseModelAllowlist("openai/gpt-5.6-luna,not a model", "openai/gpt-5.6-luna"),
    /invalid model ID/
  );
});

test("enriches only allowlisted models and flags unavailable ones", async () => {
  let calls = 0;
  const catalog = createModelCatalog({
    allowedModels,
    defaultModel: "openai/gpt-5.6-luna",
    fetchImpl: async () => { calls += 1; return upstreamResponse(upstreamModels); },
    log: silentLog,
  });

  const result = await catalog.getCatalog();
  assert.equal(result.provider, "openrouter");
  assert.equal(result.source, "openrouter");
  assert.equal(result.defaultModel, "openai/gpt-5.6-luna");
  assert.deepEqual(result.models.map((m) => [m.id, m.availability]), [
    ["openai/gpt-5.6-luna", "available"],
    ["anthropic/claude-test", "available"],
    ["removed/model", "unavailable"],
  ]);
  assert.deepEqual(result.models[0].pricing, {
    inputUsdPerMillionTokens: 0.2,
    outputUsdPerMillionTokens: 1.2,
  });
  assert.equal(result.models[0].contextLength, 128_000);
  assert.equal(result.models[0].isDefault, true);
  assert.ok(!result.models.some((m) => m.id === "not/allowlisted"));

  await catalog.getCatalog();
  assert.equal(calls, 1, "a fresh cache does not refetch");
});

test("returns the allowlist with unknown availability when the lookup fails", async () => {
  const catalog = createModelCatalog({
    allowedModels,
    defaultModel: "openai/gpt-5.6-luna",
    fetchImpl: async () => { throw new Error("network down"); },
    log: silentLog,
  });

  const result = await catalog.getCatalog();
  assert.equal(result.source, "allowlist");
  assert.equal(result.fetchedAt, null);
  assert.deepEqual(result.models.map((m) => m.availability), ["unknown", "unknown", "unknown"]);
});

test("serves stale data while refreshing after the TTL expires", async () => {
  let clock = 0;
  let calls = 0;
  let releaseRefresh;
  const catalog = createModelCatalog({
    allowedModels,
    defaultModel: "openai/gpt-5.6-luna",
    ttlMs: 1_000,
    now: () => clock,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return upstreamResponse(upstreamModels);
      await new Promise((resolve) => { releaseRefresh = resolve; });
      return upstreamResponse(upstreamModels.filter((m) => m.id !== "anthropic/claude-test"));
    },
    log: silentLog,
  });

  await catalog.getCatalog();
  clock = 5_000;
  const stale = await catalog.getCatalog();
  assert.equal(calls, 2);
  assert.equal(stale.models[1].availability, "available", "stale data is served without waiting");

  releaseRefresh();
  await new Promise((resolve) => setImmediate(resolve));
  const refreshed = await catalog.getCatalog();
  assert.equal(refreshed.models[1].availability, "unavailable");
});

test("checks selections against the allowlist and exposes no models for Groq", async () => {
  const catalog = createModelCatalog({
    allowedModels,
    defaultModel: "openai/gpt-5.6-luna",
    fetchImpl: async () => upstreamResponse([]),
  });
  assert.equal(catalog.isAllowed("anthropic/claude-test"), true);
  assert.equal(catalog.isAllowed("not/allowlisted"), false);
  assert.equal(catalog.isAllowed(undefined), false);

  const groq = createModelCatalog({ provider: "groq", fetchImpl: async () => assert.fail("no fetch") });
  assert.deepEqual(await groq.getCatalog(), {
    provider: "groq",
    defaultModel: null,
    source: "allowlist",
    fetchedAt: null,
    models: [],
  });
  assert.equal(groq.isAllowed("openai/gpt-5.6-luna"), false);
});

test("requires the default model to be allowlisted", () => {
  assert.throws(
    () => createModelCatalog({ allowedModels: ["a/b"], defaultModel: "c/d" }),
    /defaultModel must be in allowedModels/
  );
});
