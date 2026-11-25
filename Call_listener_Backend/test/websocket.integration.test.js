import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import jwt from "jsonwebtoken";
import WebSocket from "ws";
import { startWebSocketServer } from "../server/websocket/websocketServer.js";

const config = {
  APP_ID: "com.coworky.calllistener",
  JWT_SECRET: "websocket-test-secret-that-is-never-a-production-secret",
};

function issueToken(overrides = {}) {
  return jwt.sign(
    {
      app_id: config.APP_ID,
      device_id: "device-123",
      ...overrides,
    },
    config.JWT_SECRET,
    { issuer: "call-backend", audience: "call-electron", expiresIn: "5m" }
  );
}

async function withWebSocketServer(run) {
  const connections = [];
  const wss = startWebSocketServer({
    port: 0,
    config,
    handleAuthenticatedConnection: (client) => {
      connections.push(client.user);
      client.close(1000, "accepted");
    },
  });
  await once(wss, "listening");
  const { port } = wss.address();

  try {
    await run(`ws://127.0.0.1:${port}`, connections);
  } finally {
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
  }
}

test("accepts a valid query token and exposes only verified claims to the handler", async () => {
  await withWebSocketServer(async (baseUrl, connections) => {
    const client = new WebSocket(`${baseUrl}/?token=${issueToken()}`);
    const [code, reason] = await once(client, "close");

    assert.equal(code, 1000);
    assert.equal(reason.toString(), "accepted");
    assert.deepEqual(connections, [
      { app_id: config.APP_ID, device_id: "device-123" },
    ]);
  });
});

test("accepts a valid auth cookie", async () => {
  await withWebSocketServer(async (baseUrl, connections) => {
    const client = new WebSocket(baseUrl, {
      headers: { cookie: `call_token=${issueToken()}` },
    });
    const [code] = await once(client, "close");

    assert.equal(code, 1000);
    assert.equal(connections.length, 1);
  });
});

test("rejects missing or invalid WebSocket credentials before the handler runs", async () => {
  await withWebSocketServer(async (baseUrl, connections) => {
    const missing = new WebSocket(baseUrl);
    const [missingCode, missingReason] = await once(missing, "close");
    assert.equal(missingCode, 4001);
    assert.equal(missingReason.toString(), "auth_required");

    const invalid = new WebSocket(`${baseUrl}/?token=not-a-jwt`);
    const [invalidCode, invalidReason] = await once(invalid, "close");
    assert.equal(invalidCode, 4001);
    assert.equal(invalidReason.toString(), "auth_failed");
    assert.deepEqual(connections, []);
  });
});

test("requires explicit runtime dependencies", () => {
  assert.throws(() => startWebSocketServer(), /config is required/);
  assert.throws(
    () => startWebSocketServer({ config }),
    /handleAuthenticatedConnection is required/
  );
});
