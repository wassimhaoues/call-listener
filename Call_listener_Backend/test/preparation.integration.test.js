import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import jwt from "jsonwebtoken";
import { createApp } from "../server/app.js";
import { createConfiguredPreparationBrief } from "../server/services/preparation/configuredPreparation.js";
import { createFakeChatOpenRouter } from "./helpers/fakeProvider.js";
import { createMemoryRedis } from "./helpers/memoryRedis.js";
import { sampleContext, validBrief } from "./helpers/preparationFixtures.js";

const config = {
  APP_ID: "com.coworky.calllistener",
  JWT_SECRET: "test-secret-that-is-never-a-production-secret",
  JWT_TTL_SECONDS: 900,
  AI_PROVIDER: "openrouter",
  OPENROUTER_API_KEY: "test-key-not-real",
  OPENROUTER_MODEL: "openai/default",
  OPENROUTER_ALLOWED_MODELS: ["openai/default", "openai/other"],
  OPENROUTER_INPUT_USD_PER_MILLION_TOKENS: 0.2,
  OPENROUTER_OUTPUT_USD_PER_MILLION_TOKENS: 1.2,
  PREPARATION_DAILY_BUDGET_USD: 0.5,
  PREPARATION_MAX_OUTPUT_TOKENS: 2_000,
  PREPARATION_REQUEST_TIMEOUT_MS: 1_000,
  PREPARATION_RATE_LIMIT_PER_MINUTE: 3,
};

function tokenFor(deviceId = "device-123") {
  return jwt.sign({ app_id: config.APP_ID, device_id: deviceId }, config.JWT_SECRET, {
    expiresIn: 60,
    issuer: "call-backend",
    audience: "call-electron",
  });
}

async function withServer(run, { overrides = {}, script = [], responses = {} } = {}) {
  const fake = createFakeChatOpenRouter({ responses, script });
  const redisClient = createMemoryRedis();
  const appConfig = { ...config, ...overrides };
  const preparationBrief = createConfiguredPreparationBrief({
    config: appConfig,
    redisClient,
    ChatOpenRouterClass: fake.ChatOpenRouterClass,
  });
  const app = createApp({ redisClient: { status: "ready" }, config: appConfig, preparationBrief });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const post = (body, { cookie = `call_token=${tokenFor()}`, raw } = {}) =>
    fetch(`http://127.0.0.1:${port}/preparation/brief`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: raw ?? JSON.stringify(body),
    });
  try {
    await run({ post, fake, redisClient });
  } finally {
    server.close();
    await once(server, "close");
  }
}

const success = (content = JSON.stringify(validBrief()), usage = { input_tokens: 1_000, output_tokens: 500 }) => ({
  kind: "success",
  content,
  usage_metadata: usage,
});

test("preparation brief requires the auth cookie", async () => {
  await withServer(async ({ post, fake }) => {
    const anonymous = await post({ context: sampleContext() }, { cookie: null });
    assert.equal(anonymous.status, 401);
    assert.deepEqual(await anonymous.json(), { error: "no_cookie" });
    const forged = await post({ context: sampleContext() }, { cookie: "call_token=forged" });
    assert.equal(forged.status, 401);
    assert.deepEqual(await forged.json(), { error: "invalid_cookie" });
    assert.equal(fake.calls.length, 0);
  });
});

test("preparation brief returns a validated, evidence-filtered brief", async () => {
  const brief = validBrief({
    starExamples: [{ ...validBrief().starExamples[0], evidenceIds: ["E1", "Z99"] }],
  });
  await withServer(async ({ post, fake }) => {
    const response = await post({ context: sampleContext(), model: "openai/other", language: "fr" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(body.model, "openai/other");
    assert.deepEqual(body.brief.starExamples[0].evidenceIds, ["E1"]);
    assert.deepEqual(Object.keys(body.brief).sort(), [
      "introduction", "missingEvidence", "practiceTopics", "questionsToAsk", "starExamples",
    ]);
    assert.match(fake.calls[0].system, /in French/);
  }, { responses: { brief: success(JSON.stringify(brief)) }, script: ["brief"] });
});

test("preparation brief rejects invalid contexts, versions, and models with stable codes", async () => {
  await withServer(async ({ post, fake }) => {
    const cases = [
      [{ context: { caller: { name: "Legacy" } } }, "invalid_context"],
      [{ context: { ...sampleContext(), version: 3 } }, "unsupported_context_version"],
      [{ context: sampleContext(), model: "evil/model" }, "unsupported_model"],
    ];
    for (const [body, error] of cases) {
      const response = await post(body);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error });
    }
    const malformed = await post(null, { raw: "{not json" });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: "invalid_json" });
    assert.equal(fake.calls.length, 0);
  }, { overrides: { PREPARATION_RATE_LIMIT_PER_MINUTE: 10 } });
});

test("preparation brief rate-limits each installation", async () => {
  await withServer(async ({ post }) => {
    const statuses = [];
    for (let index = 0; index < 3; index += 1) {
      statuses.push((await post({ context: sampleContext() })).status);
    }
    const limited = await post({ context: sampleContext() });
    assert.deepEqual(statuses, [200, 200, 200]);
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: "preparation_rate_limited" });
    const otherDevice = await post({ context: sampleContext() }, { cookie: `call_token=${tokenFor("device-456")}` });
    assert.equal(otherDevice.status, 200);
  }, { responses: { brief: success() }, script: ["brief", "brief", "brief", "brief"] });
});

test("preparation brief stops at the daily budget", async () => {
  await withServer(async ({ post, fake }) => {
    const first = await post({ context: sampleContext() });
    assert.equal(first.status, 200);
    const second = await post({ context: sampleContext() });
    assert.equal(second.status, 429);
    assert.deepEqual(await second.json(), { error: "preparation_budget_reached" });
    assert.equal(fake.calls.length, 1);
  }, {
    // 1M output tokens at $1.20/M exceeds the $0.50 budget in one request.
    responses: { brief: success(undefined, { input_tokens: 0, output_tokens: 1_000_000 }) },
    script: ["brief", "brief"],
  });
});

test("preparation brief repairs once and then returns preparation_failed", async () => {
  await withServer(async ({ post, fake }) => {
    const repaired = await post({ context: sampleContext() });
    assert.equal(repaired.status, 200);
    const failed = await post({ context: sampleContext() });
    assert.equal(failed.status, 502);
    assert.deepEqual(await failed.json(), { error: "preparation_failed" });
    assert.equal(fake.calls.length, 4);
  }, {
    responses: { bad: success("I will not answer in JSON."), brief: success() },
    script: ["bad", "brief", "bad", "bad"],
  });
});

test("preparation brief returns preparation_failed when the provider errors", async () => {
  await withServer(async ({ post }) => {
    const response = await post({ context: sampleContext() });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "preparation_failed" });
  }, { responses: { down: { kind: "error", status: 503, message: "upstream detail" } }, script: ["down"] });
});

test("preparation brief is unavailable in Groq mode", async () => {
  await withServer(async ({ post, fake }) => {
    const response = await post({ context: sampleContext() });
    assert.equal(response.status, 501);
    assert.deepEqual(await response.json(), { error: "preparation_unavailable" });
    const anonymous = await post({ context: sampleContext() }, { cookie: null });
    assert.equal(anonymous.status, 401);
    assert.equal(fake.calls.length, 0);
  }, { overrides: { AI_PROVIDER: "groq" } });
});

test("preparation brief accepts large contexts but rejects oversized bodies", async () => {
  await withServer(async ({ post }) => {
    const large = sampleContext();
    large.jobOffer.description = "é".repeat(15_000);
    large.candidate.profile = "é".repeat(11_000);
    large.candidate.achievements = Array.from({ length: 40 }, (_, index) => `${index} ${"é".repeat(480)}`);
    const accepted = await post({ context: large });
    assert.equal(accepted.status, 200);

    const oversized = await post({ context: sampleContext(), padding: "x".repeat(300_000) });
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), { error: "payload_too_large" });
  }, { responses: { brief: success() }, script: ["brief"] });
});
