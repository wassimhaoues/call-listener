import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import WebSocket from "ws";
import { startWebSocketServer } from "../server/websocket/websocketServer.js";
import { loadFixture } from "./helpers/fixtures.js";

const fixture = loadFixture("authFailures.json");
// Generated per run so no signing secret is ever stored in the repository.
const config = { ...fixture.config, JWT_SECRET: randomBytes(32).toString("hex") };

function base64url(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function tokenFor(testCase) {
  if ("rawToken" in testCase) return testCase.rawToken;
  const claims = { ...fixture.defaultClaims, ...testCase.claims };
  if (testCase.unsigned) {
    return `${base64url({ alg: "none", typ: "JWT" })}.${base64url(claims)}.`;
  }
  const secret = testCase.wrongSecret ? randomBytes(32).toString("hex") : config.JWT_SECRET;
  return jwt.sign(claims, secret, {
    issuer: "call-backend",
    audience: "call-electron",
    expiresIn: "5m",
    ...testCase.sign,
  });
}

function connect(baseUrl, testCase) {
  if (testCase.transport === "none") return new WebSocket(baseUrl);
  const token = tokenFor(testCase);
  if (testCase.transport === "query") {
    return new WebSocket(`${baseUrl}/?token=${encodeURIComponent(token)}`);
  }
  return new WebSocket(baseUrl, { headers: { cookie: `call_token=${token}` } });
}

test("WebSocket authentication fixtures close with the documented code and reason", async () => {
  const reached = [];
  const wss = startWebSocketServer({
    port: 0,
    config,
    handleAuthenticatedConnection: (client) => {
      reached.push(client.user);
      client.close(1000, "accepted");
    },
  });
  await once(wss, "listening");
  const baseUrl = `ws://127.0.0.1:${wss.address().port}`;

  try {
    for (const testCase of fixture.cases) {
      const before = reached.length;
      const client = connect(baseUrl, testCase);
      const [code, reason] = await once(client, "close");

      assert.deepEqual(
        { code, reason: reason.toString() },
        { code: testCase.expect.code, reason: testCase.expect.reason },
        testCase.name
      );
      assert.equal(reached.length - before, testCase.expect.handlerReached ? 1 : 0, testCase.name);
    }
    assert.ok(reached.every((user) => user.device_id === fixture.defaultClaims.device_id));
  } finally {
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
  }
});
