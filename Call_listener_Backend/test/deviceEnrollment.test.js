import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { createApp } from "../server/app.js";
import {
  createDeviceEnrollment,
  enrollmentKey,
  ENROLLMENT_ERROR,
  isDeviceSecret,
} from "../server/services/auth/deviceEnrollment.js";
import { createMemoryRedis } from "./helpers/memoryRedis.js";

const DEVICE = "5d2a8f61-3c4e-4b7a-9e10-7a8b9c0d1e2f";
const secret = () => randomBytes(32).toString("base64url");
const silent = { info() {}, warn() {}, error() {} };

function failingRedis() {
  const fail = async () => {
    throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  };
  return { get: fail, set: fail, del: fail };
}

test("the first secret enrolls an installation and only that secret works afterwards", async () => {
  const redisClient = createMemoryRedis();
  const enrollment = createDeviceEnrollment({ redisClient, log: silent });
  const mine = secret();

  assert.deepEqual(await enrollment.check(DEVICE, mine), { allowed: true, enrolled: true, newlyEnrolled: true });
  assert.deepEqual(await enrollment.check(DEVICE, mine), { allowed: true, enrolled: true });
  assert.deepEqual(await enrollment.check(DEVICE, secret()), { allowed: false, error: ENROLLMENT_ERROR.INVALID });
  assert.deepEqual(await enrollment.check(DEVICE, undefined), { allowed: false, error: ENROLLMENT_ERROR.INVALID }, "an enrolled ID needs its secret");

  const stored = await redisClient.get(enrollmentKey(DEVICE));
  assert.ok(!stored.includes(DEVICE) && !stored.includes(mine), "neither the ID nor the secret is stored");
  assert.ok(!enrollmentKey(DEVICE).includes(DEVICE));

  assert.equal(await enrollment.reset(DEVICE), true);
  assert.equal(await enrollment.isEnrolled(DEVICE), false);
});

test("concurrent first uses with different secrets enroll exactly one", async () => {
  const enrollment = createDeviceEnrollment({ redisClient: createMemoryRedis(), log: silent });
  const results = await Promise.all([enrollment.check(DEVICE, secret()), enrollment.check(DEVICE, secret())]);
  assert.deepEqual(results.map((result) => result.allowed).sort(), [false, true]);
});

test("legacy clients without a secret pass only while enrollment is optional and the ID is unenrolled", async () => {
  const optional = createDeviceEnrollment({ redisClient: createMemoryRedis(), log: silent });
  assert.deepEqual(await optional.check(DEVICE, undefined), { allowed: true, enrolled: false });
  const required = createDeviceEnrollment({ redisClient: createMemoryRedis(), required: true, log: silent });
  assert.deepEqual(await required.check(DEVICE, undefined), { allowed: false, error: ENROLLMENT_ERROR.REQUIRED });
  assert.deepEqual(await optional.check(DEVICE, "short"), { allowed: false, error: ENROLLMENT_ERROR.INVALID });
  assert.equal(isDeviceSecret(secret()), true);
  assert.equal(isDeviceSecret(42), false);
});

test("a Redis failure fails closed whenever a secret is involved or required", async () => {
  const log = { lines: [], info() {}, warn(line) { this.lines.push(line); }, error() {} };
  const optional = createDeviceEnrollment({ redisClient: failingRedis(), log });
  assert.deepEqual(await optional.check(DEVICE, secret()), { allowed: false, error: ENROLLMENT_ERROR.UNAVAILABLE });
  assert.deepEqual(await optional.check(DEVICE, undefined), { allowed: true, enrolled: false, unverified: true });
  const required = createDeviceEnrollment({ redisClient: failingRedis(), required: true, log });
  assert.deepEqual(await required.check(DEVICE, undefined), { allowed: false, error: ENROLLMENT_ERROR.UNAVAILABLE });
  assert.ok(log.lines.every((line) => !line.includes(DEVICE)));
});

test("POST /auth/token enrolls on first use and then requires the same secret", async () => {
  const config = {
    APP_ID: "com.example.calllistener.enrollment",
    JWT_SECRET: randomBytes(32).toString("hex"),
    JWT_TTL_SECONDS: 900,
    AUTH_RATE_LIMIT_PER_MINUTE: 100,
  };
  const redisClient = Object.assign(createMemoryRedis(), { status: "ready" });
  const server = createApp({ redisClient, config, log: silent }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/auth/token`;
  const post = (body) =>
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app_id: config.APP_ID, device_id: DEVICE, ...body }) });
  try {
    const mine = secret();
    assert.equal((await post({ device_secret: mine })).status, 200);
    assert.equal((await post({ device_secret: mine })).status, 200);
    const wrong = await post({ device_secret: secret() });
    assert.equal(wrong.status, 401);
    assert.deepEqual(await wrong.json(), { error: "device_secret_invalid" });
    assert.equal(wrong.headers.get("set-cookie"), null, "no cookie for a failed proof");
    assert.equal((await post({})).status, 401, "an enrolled ID cannot fall back to no secret");
    const malformed = await post({ device_secret: "x" });
    assert.equal(malformed.status, 401);
  } finally {
    server.close();
  }
});
