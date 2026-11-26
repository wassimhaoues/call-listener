import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";

const execFileAsync = promisify(execFile);
const envModuleUrl = new URL("../server/config/env.js", import.meta.url).href;

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

function loadAllowlist(env) {
  return execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { CONFIG } from ${JSON.stringify(envModuleUrl)}; process.stdout.write(JSON.stringify(CONFIG.OPENROUTER_ALLOWED_MODELS));`,
    ],
    { cwd: os.tmpdir(), env: { ...baseEnv, ...env } }
  );
}

test("model allowlist defaults to OPENROUTER_MODEL and rejects lists without it", async () => {
  const defaults = await loadAllowlist({ OPENROUTER_MODEL: "openai/gpt-4.1-mini" });
  assert.deepEqual(JSON.parse(defaults.stdout), ["openai/gpt-4.1-mini"]);

  const configured = await loadAllowlist({
    OPENROUTER_MODEL: "openai/gpt-4.1-mini",
    OPENROUTER_ALLOWED_MODELS: "openai/gpt-4.1-mini,anthropic/claude-test",
    OPENROUTER_MODEL_PRICES: JSON.stringify({ "anthropic/claude-test": { input: 3, output: 15 } }),
  });
  assert.deepEqual(JSON.parse(configured.stdout), ["openai/gpt-4.1-mini", "anthropic/claude-test"]);

  await assert.rejects(
    loadAllowlist({
      OPENROUTER_MODEL: "openai/gpt-4.1-mini",
      OPENROUTER_ALLOWED_MODELS: "anthropic/claude-test",
    }),
    /must include OPENROUTER_MODEL/
  );
});

test("OpenRouter configuration does not require a Groq key", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { CONFIG } from ${JSON.stringify(envModuleUrl)}; process.stdout.write(CONFIG.AI_PROVIDER);`,
    ],
    {
      cwd: os.tmpdir(),
      env: {
        PATH: process.env.PATH,
        AI_PROVIDER: "openrouter",
        OPENROUTER_API_KEY: "test-openrouter-key",
        DEEPGRAM_API_KEY: "test-deepgram-key",
        REDIS_URL: "redis://127.0.0.1:6379",
        APP_ID: "com.coworky.calllistener",
        JWT_SECRET: "test-jwt-secret",
        JWT_TTL_SECONDS: "900",
      },
    }
  );

  assert.equal(stdout, "openrouter");
});

function loadMaxRetries(env) {
  return execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { CONFIG } from ${JSON.stringify(envModuleUrl)}; process.stdout.write(String(CONFIG.OPENROUTER_MAX_RETRIES));`,
    ],
    { cwd: os.tmpdir(), env: { ...baseEnv, ...env } }
  );
}

test("OPENROUTER_MAX_RETRIES defaults to one retry and accepts only 0 to 2", async () => {
  assert.equal((await loadMaxRetries({})).stdout, "1");
  assert.equal((await loadMaxRetries({ OPENROUTER_MAX_RETRIES: "0" })).stdout, "0");
  assert.equal((await loadMaxRetries({ OPENROUTER_MAX_RETRIES: "2" })).stdout, "2");
  for (const value of ["3", "-1", "1.5", "many"]) {
    await assert.rejects(loadMaxRetries({ OPENROUTER_MAX_RETRIES: value }), /OPENROUTER_MAX_RETRIES/);
  }
});

const PREPARATION_KEYS = [
  "PREPARATION_DAILY_BUDGET_USD",
  "PREPARATION_MAX_OUTPUT_TOKENS",
  "PREPARATION_REQUEST_TIMEOUT_MS",
  "PREPARATION_RATE_LIMIT_PER_MINUTE",
];

function loadPreparationConfig(env) {
  return execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { CONFIG } from ${JSON.stringify(envModuleUrl)}; process.stdout.write(JSON.stringify(${JSON.stringify(PREPARATION_KEYS)}.map((key) => CONFIG[key])));`,
    ],
    { cwd: os.tmpdir(), env: { ...baseEnv, ...env } }
  );
}

test("preparation limits have bounded defaults and reject invalid values", async () => {
  const defaults = await loadPreparationConfig({});
  assert.deepEqual(JSON.parse(defaults.stdout), [0.5, 3000, 22000, 3]);
  const configured = await loadPreparationConfig({
    PREPARATION_DAILY_BUDGET_USD: "0",
    PREPARATION_RATE_LIMIT_PER_MINUTE: "5",
  });
  assert.deepEqual(JSON.parse(configured.stdout), [0, 3000, 22000, 5]);
  await assert.rejects(loadPreparationConfig({ PREPARATION_DAILY_BUDGET_USD: "-1" }), /PREPARATION_DAILY_BUDGET_USD/);
  await assert.rejects(
    loadPreparationConfig({ PREPARATION_RATE_LIMIT_PER_MINUTE: "1.5" }),
    /PREPARATION_RATE_LIMIT_PER_MINUTE/
  );
});

const WS_TICKET_KEYS = ["WS_TICKET_TTL_SECONDS", "WS_TICKET_RATE_LIMIT_PER_MINUTE", "WS_ALLOW_COOKIE_AUTH"];

function loadWsTicketConfig(env) {
  return execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { CONFIG } from ${JSON.stringify(envModuleUrl)}; process.stdout.write(JSON.stringify(${JSON.stringify(WS_TICKET_KEYS)}.map((key) => CONFIG[key])));`,
    ],
    { cwd: os.tmpdir(), env: { ...baseEnv, ...env } }
  );
}

test("WebSocket ticket settings have compatible defaults and reject invalid values", async () => {
  const defaults = await loadWsTicketConfig({});
  assert.deepEqual(JSON.parse(defaults.stdout), [30, 30, true]);
  const configured = await loadWsTicketConfig({
    WS_TICKET_TTL_SECONDS: "10",
    WS_TICKET_RATE_LIMIT_PER_MINUTE: "5",
    WS_ALLOW_COOKIE_AUTH: "false",
  });
  assert.deepEqual(JSON.parse(configured.stdout), [10, 5, false]);
  for (const value of ["0", "301", "1.5", "soon"]) {
    await assert.rejects(loadWsTicketConfig({ WS_TICKET_TTL_SECONDS: value }), /WS_TICKET_TTL_SECONDS/);
  }
  await assert.rejects(loadWsTicketConfig({ WS_TICKET_RATE_LIMIT_PER_MINUTE: "0" }), /WS_TICKET_RATE_LIMIT_PER_MINUTE/);
  await assert.rejects(loadWsTicketConfig({ WS_ALLOW_COOKIE_AUTH: "no" }), /WS_ALLOW_COOKIE_AUTH must be true or false/);
});

const REVOCATION_KEYS = ["REVOCATION_FAIL_CLOSED", "REVOCATION_SWEEP_MS"];

function loadRevocationConfig(env) {
  return execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { CONFIG } from ${JSON.stringify(envModuleUrl)}; process.stdout.write(JSON.stringify(${JSON.stringify(REVOCATION_KEYS)}.map((key) => CONFIG[key])));`,
    ],
    { cwd: os.tmpdir(), env: { ...baseEnv, ...env } }
  );
}

test("device revocation settings default to fail-open with a one-minute sweep", async () => {
  const defaults = await loadRevocationConfig({});
  assert.deepEqual(JSON.parse(defaults.stdout), [false, 60_000]);
  const configured = await loadRevocationConfig({ REVOCATION_FAIL_CLOSED: "true", REVOCATION_SWEEP_MS: "5000" });
  assert.deepEqual(JSON.parse(configured.stdout), [true, 5000]);
  await assert.rejects(loadRevocationConfig({ REVOCATION_FAIL_CLOSED: "yes" }), /REVOCATION_FAIL_CLOSED must be true or false/);
  for (const value of ["999", "3600001", "1.5", "soon"]) {
    await assert.rejects(loadRevocationConfig({ REVOCATION_SWEEP_MS: value }), /REVOCATION_SWEEP_MS/);
  }
});

function loadMaxModelCalls(env) {
  return execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { CONFIG } from ${JSON.stringify(envModuleUrl)}; process.stdout.write(String(CONFIG.MAX_INTERVIEW_MODEL_CALLS));`,
    ],
    { cwd: os.tmpdir(), env: { ...baseEnv, ...env } }
  );
}

test("MAX_INTERVIEW_MODEL_CALLS defaults to 400 and accepts only positive integers", async () => {
  assert.equal((await loadMaxModelCalls({})).stdout, "400");
  assert.equal((await loadMaxModelCalls({ MAX_INTERVIEW_MODEL_CALLS: "50" })).stdout, "50");
  for (const value of ["-1", "1.5", "many"]) {
    await assert.rejects(loadMaxModelCalls({ MAX_INTERVIEW_MODEL_CALLS: value }), /MAX_INTERVIEW_MODEL_CALLS/);
  }
});
