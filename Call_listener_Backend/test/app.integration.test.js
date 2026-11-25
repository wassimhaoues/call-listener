import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import jwt from "jsonwebtoken";
import { createApp } from "../server/app.js";

const config = {
  APP_ID: "com.coworky.calllistener",
  JWT_SECRET: "test-secret-that-is-never-a-production-secret",
  JWT_TTL_SECONDS: 900,
};

async function withServer(run) {
  const app = createApp({ redisClient: { status: "ready" }, config });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();

  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("health reports the injected Redis status", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok", redis: "ready" });
  });
});

test("readiness requires Redis to be ready while health remains a liveness check", async () => {
  await withServer(async (baseUrl) => {
    const ready = await fetch(`${baseUrl}/ready`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { status: "ready", redis: "ready" });
  });

  const app = createApp({ redisClient: { status: "reconnecting" }, config });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/ready`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      status: "not_ready",
      redis: "reconnecting",
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("token endpoint rejects an invalid app or device ID", async () => {
  await withServer(async (baseUrl) => {
    const invalidApp = await fetch(`${baseUrl}/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: "other-app", device_id: "device-123" }),
    });
    assert.equal(invalidApp.status, 401);
    assert.deepEqual(await invalidApp.json(), { error: "invalid app" });

    const invalidDevice = await fetch(`${baseUrl}/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: config.APP_ID, device_id: "short" }),
    });
    assert.equal(invalidDevice.status, 400);
    assert.deepEqual(await invalidDevice.json(), { error: "invalid device_id" });
  });
});

test("token endpoint issues a verifiable token and auth/me accepts its cookie", async () => {
  await withServer(async (baseUrl) => {
    const tokenResponse = await fetch(`${baseUrl}/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: config.APP_ID, device_id: "device-123" }),
    });

    assert.equal(tokenResponse.status, 200);
    const { token, expires_in: expiresIn } = await tokenResponse.json();
    assert.equal(expiresIn, config.JWT_TTL_SECONDS);
    assert.match(tokenResponse.headers.get("set-cookie") || "", /call_token=/);

    const claims = jwt.verify(token, config.JWT_SECRET, {
      issuer: "call-backend",
      audience: "call-electron",
    });
    assert.equal(claims.app_id, config.APP_ID);
    assert.equal(claims.device_id, "device-123");

    const meResponse = await fetch(`${baseUrl}/auth/me`, {
      headers: { cookie: `call_token=${token}` },
    });
    assert.equal(meResponse.status, 200);
    const me = await meResponse.json();
    assert.equal(me.ok, true);
    assert.equal(me.claims.device_id, "device-123");
  });
});

test("local development tokens use a host-only non-secure cookie", async () => {
  const localConfig = {
    ...config,
    COOKIE_SECURE: false,
    COOKIE_DOMAIN: undefined,
  };
  const app = createApp({ redisClient: { status: "ready" }, config: localConfig });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: config.APP_ID, device_id: "device-123" }),
    });
    const cookie = response.headers.get("set-cookie") || "";
    assert.equal(response.status, 200);
    assert.match(cookie, /SameSite=Lax/);
    assert.doesNotMatch(cookie, /Secure/);
    assert.doesNotMatch(cookie, /Domain=/);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("createApp requires explicit runtime dependencies", () => {
  assert.throws(() => createApp(), /redisClient is required/);
  assert.throws(
    () => createApp({ redisClient: { status: "ready" } }),
    /config is required/
  );
});
