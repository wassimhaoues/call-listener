import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import WebSocket from "ws";
import { createApp } from "../server/app.js";
import { startWebSocketServer } from "../server/websocket/websocketServer.js";
import { createWsTicketStore } from "../server/services/auth/wsTicketStore.js";
import { createDeviceRevocation } from "../server/services/auth/deviceRevocation.js";
import { createMemoryRedis } from "./helpers/memoryRedis.js";

// Generated per run so no signing secret is ever stored in the repository.
const baseConfig = {
  APP_ID: "com.example.calllistener.revocation",
  JWT_SECRET: randomBytes(32).toString("hex"),
  JWT_TTL_SECONDS: 900,
  WS_TICKET_TTL_SECONDS: 30,
  WS_TICKET_RATE_LIMIT_PER_MINUTE: 100,
  AUTH_RATE_LIMIT_PER_MINUTE: 100,
};
const REVOKED_DEVICE = "6f1c9a52-0d4b-4c43-9a57-2f7f1d1c0a01";
const OTHER_DEVICE = "0b7d3e18-5a6c-4f2e-8d90-6c2a4b1e9f02";

function issueJwt(deviceId = REVOKED_DEVICE) {
  return jwt.sign({ app_id: baseConfig.APP_ID, device_id: deviceId }, baseConfig.JWT_SECRET, {
    issuer: "call-backend",
    audience: "call-electron",
    expiresIn: "5m",
  });
}

function unavailableRedis() {
  const fail = async () => {
    const error = new Error("connect ECONNREFUSED");
    error.code = "ECONNREFUSED";
    throw error;
  };
  return { get: fail, set: fail, del: fail };
}

function createLog() {
  const lines = [];
  const push = (line) => lines.push(String(line));
  return { lines, warn: push, error: push, info: push };
}

/** Express and the WebSocket server sharing one ticket store and deny-list, as in index.js. */
async function withServers(run, { deviceRevocation: injected, sweepMs = 0, handler } = {}) {
  const config = { ...baseConfig };
  const redisClient = Object.assign(createMemoryRedis(), { status: "ready" });
  const wsTickets = createWsTicketStore({ redisClient, ttlSeconds: config.WS_TICKET_TTL_SECONDS });
  const deviceRevocation = injected ?? createDeviceRevocation({ redisClient });
  const reached = [];
  const handleAuthenticatedConnection =
    handler ??
    ((client) => {
      reached.push(client.user);
      client.close(1000, "accepted");
    });
  const app = createApp({ redisClient, config, wsTickets, deviceRevocation });
  const http = app.listen(0, "127.0.0.1");
  await once(http, "listening");
  const wss = startWebSocketServer({
    port: 0,
    config,
    handleAuthenticatedConnection,
    wsTickets,
    deviceRevocation,
    revocationSweepMs: sweepMs,
  });
  await once(wss, "listening");
  const httpUrl = `http://127.0.0.1:${http.address().port}`;
  const wsUrl = `ws://127.0.0.1:${wss.address().port}/ws`;
  const withCookie = (path, deviceId, init = {}) =>
    fetch(httpUrl + path, { ...init, headers: { ...init.headers, cookie: `call_token=${issueJwt(deviceId)}` } });
  const requestToken = (deviceId) =>
    fetch(`${httpUrl}/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: config.APP_ID, device_id: deviceId }),
    });
  try {
    await run({ httpUrl, wsUrl, redisClient, reached, wsTickets, deviceRevocation, withCookie, requestToken });
  } finally {
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
    http.close();
    await once(http, "close");
  }
}

async function closeOf(socket) {
  const [code, reason] = await once(socket, "close");
  return { code, reason: reason.toString() };
}

test("POST /auth/token refuses a revoked installation with 403 device_revoked", async () => {
  await withServers(async ({ requestToken, deviceRevocation }) => {
    await deviceRevocation.revoke(REVOKED_DEVICE, { reason: "ticket 142" });
    const refused = await requestToken(REVOKED_DEVICE);
    assert.equal(refused.status, 403);
    assert.deepEqual(await refused.json(), { error: "device_revoked" });
    assert.equal(refused.headers.get("set-cookie"), null, "no cookie for a revoked device");

    const other = await requestToken(OTHER_DEVICE);
    assert.equal(other.status, 200);
  });
});

test("POST /ws-ticket refuses a revoked installation before issuing a ticket", async () => {
  await withServers(async ({ withCookie, deviceRevocation, redisClient }) => {
    await deviceRevocation.revoke(REVOKED_DEVICE);
    const refused = await withCookie("/ws-ticket", REVOKED_DEVICE, { method: "POST" });
    assert.equal(refused.status, 403);
    assert.deepEqual(await refused.json(), { error: "device_revoked" });
    const ticketKeys = [...redisClient.ttls.keys()].filter((key) => key.startsWith("wsticket:"));
    assert.equal(ticketKeys.length, 0);

    const other = await withCookie("/ws-ticket", OTHER_DEVICE, { method: "POST" });
    assert.equal(other.status, 200);
  });
});

test("GET /auth/me, /models and /preparation/brief refuse a still-valid JWT of a revoked installation", async () => {
  await withServers(async ({ withCookie, deviceRevocation }) => {
    assert.equal((await withCookie("/auth/me", REVOKED_DEVICE)).status, 200);
    await deviceRevocation.revoke(REVOKED_DEVICE);

    const me = await withCookie("/auth/me", REVOKED_DEVICE);
    assert.equal(me.status, 403);
    assert.deepEqual(await me.json(), { error: "device_revoked" });
    const models = await withCookie("/models", REVOKED_DEVICE);
    assert.equal(models.status, 403);
    const brief = await withCookie("/preparation/brief", REVOKED_DEVICE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(brief.status, 403);
    assert.deepEqual(await brief.json(), { error: "device_revoked" });
  });
});

test("restore lets the installation authenticate again", async () => {
  await withServers(async ({ requestToken, withCookie, deviceRevocation }) => {
    await deviceRevocation.revoke(REVOKED_DEVICE);
    assert.equal((await requestToken(REVOKED_DEVICE)).status, 403);
    assert.equal(await deviceRevocation.restore(REVOKED_DEVICE), true);
    assert.equal((await requestToken(REVOKED_DEVICE)).status, 200);
    assert.equal((await withCookie("/auth/me", REVOKED_DEVICE)).status, 200);
  });
});

test("a ticket issued before revocation no longer opens a socket (4003 device_revoked)", async () => {
  await withServers(async ({ withCookie, wsUrl, deviceRevocation, reached }) => {
    const res = await withCookie("/ws-ticket", REVOKED_DEVICE, { method: "POST" });
    const { ticket } = await res.json();
    await deviceRevocation.revoke(REVOKED_DEVICE);

    const socket = new WebSocket(`${wsUrl}?ticket=${encodeURIComponent(ticket)}`);
    assert.deepEqual(await closeOf(socket), { code: 4003, reason: "device_revoked" });
    assert.equal(reached.length, 0);
  });
});

test("the cookie and ?token= socket paths refuse a revoked installation (4003 device_revoked)", async () => {
  await withServers(async ({ wsUrl, deviceRevocation, reached }) => {
    await deviceRevocation.revoke(REVOKED_DEVICE);
    const viaCookie = new WebSocket(wsUrl, { headers: { cookie: `call_token=${issueJwt()}` } });
    assert.deepEqual(await closeOf(viaCookie), { code: 4003, reason: "device_revoked" });
    const viaQuery = new WebSocket(`${wsUrl}?token=${encodeURIComponent(issueJwt())}`);
    assert.deepEqual(await closeOf(viaQuery), { code: 4003, reason: "device_revoked" });
    assert.equal(reached.length, 0);

    const other = new WebSocket(wsUrl, { headers: { cookie: `call_token=${issueJwt(OTHER_DEVICE)}` } });
    assert.deepEqual(await closeOf(other), { code: 1000, reason: "accepted" });
    assert.deepEqual(reached, [{ device_id: OTHER_DEVICE, app_id: baseConfig.APP_ID }]);
  });
});

test("open sockets of a revoked installation close within one sweep; other installations stay open", async () => {
  const open = [];
  await withServers(
    async ({ wsUrl, deviceRevocation }) => {
      const connect = async (deviceId) => {
        const socket = new WebSocket(wsUrl, { headers: { cookie: `call_token=${issueJwt(deviceId)}` } });
        await once(socket, "open");
        return socket;
      };
      const [first, second, other] = await Promise.all([
        connect(REVOKED_DEVICE),
        connect(REVOKED_DEVICE),
        connect(OTHER_DEVICE),
      ]);
      const closes = Promise.all([closeOf(first), closeOf(second)]);
      const revokedAt = Date.now();
      await deviceRevocation.revoke(REVOKED_DEVICE);

      const results = await closes;
      assert.deepEqual(results, [
        { code: 4003, reason: "device_revoked" },
        { code: 4003, reason: "device_revoked" },
      ]);
      assert.ok(Date.now() - revokedAt < 2_000, "closed within a bounded time");
      assert.equal(other.readyState, WebSocket.OPEN);
      other.close();
      await once(other, "close");
    },
    { sweepMs: 25, handler: (client) => open.push(client) }
  );
  assert.equal(open.length, 3);
});

test("the sweep never closes sockets when the deny-list is unreachable", async () => {
  const log = createLog();
  // Even in fail-closed mode: the store works at connect time and fails afterwards.
  let healthy = true;
  const memory = createMemoryRedis();
  const down = unavailableRedis();
  let failedLookups = 0;
  const flaky = {
    get(key) {
      if (healthy) return memory.get(key);
      failedLookups += 1;
      return down.get(key);
    },
  };
  const revocation = createDeviceRevocation({ redisClient: flaky, failClosed: true, log });
  await withServers(
    async ({ wsUrl }) => {
      const socket = new WebSocket(wsUrl, { headers: { cookie: `call_token=${issueJwt()}` } });
      await once(socket, "open");
      healthy = false;
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.equal(socket.readyState, WebSocket.OPEN);
      socket.close();
      await once(socket, "close");
    },
    { deviceRevocation: revocation, sweepMs: 20, handler: () => {} }
  );
  assert.ok(failedLookups > 0, "the sweep ran against the unreachable deny-list");
});

test("fail-open (default): a Redis failure on the deny-list still authenticates, and logs a warning", async () => {
  const log = createLog();
  const deviceRevocation = createDeviceRevocation({ redisClient: unavailableRedis(), log });
  await withServers(
    async ({ requestToken, withCookie, wsUrl, reached }) => {
      assert.equal((await requestToken(REVOKED_DEVICE)).status, 200);
      assert.equal((await withCookie("/auth/me", REVOKED_DEVICE)).status, 200);
      const res = await withCookie("/ws-ticket", REVOKED_DEVICE, { method: "POST" });
      assert.equal(res.status, 200);
      const { ticket } = await res.json();
      const socket = new WebSocket(`${wsUrl}?ticket=${encodeURIComponent(ticket)}`);
      assert.deepEqual(await closeOf(socket), { code: 1000, reason: "accepted" });
      assert.equal(reached.length, 1);
    },
    { deviceRevocation }
  );
  assert.ok(log.lines.some((line) => line.includes("fail-open") && line.includes("ECONNREFUSED")));
  assert.ok(log.lines.every((line) => !line.includes(REVOKED_DEVICE)), "logs never carry the device ID");
});

test("fail-closed: a Redis failure on the deny-list refuses tokens, tickets and sockets", async () => {
  const log = createLog();
  const deviceRevocation = createDeviceRevocation({ redisClient: unavailableRedis(), failClosed: true, log });
  await withServers(
    async ({ requestToken, withCookie, wsUrl, reached }) => {
      const token = await requestToken(REVOKED_DEVICE);
      assert.equal(token.status, 503);
      assert.deepEqual(await token.json(), { error: "revocation_unavailable" });
      const me = await withCookie("/auth/me", REVOKED_DEVICE);
      assert.equal(me.status, 503);
      const ticket = await withCookie("/ws-ticket", REVOKED_DEVICE, { method: "POST" });
      assert.equal(ticket.status, 503);
      assert.deepEqual(await ticket.json(), { error: "revocation_unavailable" });
      const socket = new WebSocket(wsUrl, { headers: { cookie: `call_token=${issueJwt()}` } });
      assert.deepEqual(await closeOf(socket), { code: 1011, reason: "auth_unavailable" });
      assert.equal(reached.length, 0);
    },
    { deviceRevocation }
  );
  assert.ok(log.lines.some((line) => line.includes("fail-closed")));
});
