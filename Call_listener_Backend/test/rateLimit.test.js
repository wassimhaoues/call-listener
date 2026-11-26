import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createFixedWindowLimiter } from "../server/core/rateLimit.js";
import { createApp } from "../server/app.js";
import { createMemoryRedis } from "./helpers/memoryRedis.js";

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function hit(limiter, ip) {
  const res = fakeRes();
  let passed = false;
  await limiter({ ip }, res, () => {
    passed = true;
  });
  return { passed, res };
}

test("the limiter allows `limit` requests per key per window, then answers 429", async () => {
  const redisClient = createMemoryRedis();
  const limiter = createFixedWindowLimiter({ redisClient, prefix: "rl:test", limit: 2, windowSeconds: 60 });
  assert.equal((await hit(limiter, "203.0.113.1")).passed, true);
  assert.equal((await hit(limiter, "203.0.113.1")).passed, true);
  const third = await hit(limiter, "203.0.113.1");
  assert.equal(third.passed, false);
  assert.equal(third.res.statusCode, 429);
  assert.deepEqual(third.res.body, { error: "rate_limited" });
  assert.equal(third.res.headers["Retry-After"], "60");
  assert.equal((await hit(limiter, "203.0.113.2")).passed, true, "other clients are unaffected");
});

test("limiter keys are hashed and expire with the window", async () => {
  const redisClient = createMemoryRedis();
  const limiter = createFixedWindowLimiter({ redisClient, prefix: "rl:test", limit: 5, windowSeconds: 60 });
  await hit(limiter, "198.51.100.7");
  const keys = [...redisClient.ttls.keys()];
  assert.equal(keys.length, 1);
  assert.match(keys[0], /^rl:test:[0-9a-f]{32}$/);
  assert.ok(!keys[0].includes("198.51.100.7"));
  assert.equal(redisClient.ttls.get(keys[0]), 60);
});

test("the limiter fails open when Redis errors", async () => {
  const warnings = [];
  const limiter = createFixedWindowLimiter({
    redisClient: { incr: async () => { throw Object.assign(new Error("down"), { code: "ECONNREFUSED" }); } },
    prefix: "rl:test",
    limit: 1,
    windowSeconds: 60,
    log: { warn: (message) => warnings.push(message) },
  });
  assert.equal((await hit(limiter, "203.0.113.9")).passed, true);
  assert.equal(warnings.length, 1);
});

test("limiter options are validated", () => {
  const redisClient = createMemoryRedis();
  assert.throws(() => createFixedWindowLimiter({ prefix: "rl:x", limit: 1, windowSeconds: 1 }), /redisClient/);
  assert.throws(() => createFixedWindowLimiter({ redisClient, prefix: "Bad Prefix", limit: 1, windowSeconds: 1 }), /prefix/);
  assert.throws(() => createFixedWindowLimiter({ redisClient, prefix: "rl:x", limit: 0, windowSeconds: 1 }), /limit/);
  assert.throws(() => createFixedWindowLimiter({ redisClient, prefix: "rl:x", limit: 1, windowSeconds: 0 }), /windowSeconds/);
});

test("POST /auth/token is rate limited per client", async () => {
  const redisClient = Object.assign(createMemoryRedis(), { status: "ready" });
  const config = {
    APP_ID: "com.coworky.calllistener",
    JWT_SECRET: "test-secret-that-is-never-a-production-secret",
    JWT_TTL_SECONDS: 900,
    AUTH_RATE_LIMIT_PER_MINUTE: 2,
  };
  const app = createApp({ redisClient, config });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/auth/token`;
  const post = () =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: config.APP_ID, device_id: "device-123456" }),
    });
  try {
    assert.equal((await post()).status, 200);
    assert.equal((await post()).status, 200);
    const limited = await post();
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: "rate_limited" });
  } finally {
    server.close();
    await once(server, "close");
  }
});
