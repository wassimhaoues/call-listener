import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import WebSocket from "ws";
import { createApp } from "../server/app.js";
import { startWebSocketServer } from "../server/websocket/websocketServer.js";
import { createWsTicketStore } from "../server/services/auth/wsTicketStore.js";
import { SESSION_STATE } from "../server/services/session/sessionManager.js";
import { createMemoryRedis } from "./helpers/memoryRedis.js";
import { CANDIDATE_CONTEXT, createSessionHarness } from "./helpers/sessionHarness.js";

// Generated per run so no signing secret is ever stored in the repository.
const baseConfig = {
  APP_ID: "com.example.calllistener.tickets",
  JWT_SECRET: randomBytes(32).toString("hex"),
  JWT_TTL_SECONDS: 900,
  WS_TICKET_TTL_SECONDS: 30,
  WS_TICKET_RATE_LIMIT_PER_MINUTE: 3,
};

function issueJwt(deviceId = "device-123456", { appId = baseConfig.APP_ID, secret = baseConfig.JWT_SECRET } = {}) {
  return jwt.sign({ app_id: appId, device_id: deviceId }, secret, {
    issuer: "call-backend",
    audience: "call-electron",
    expiresIn: "5m",
  });
}

function makeClock(start = 1_000_000) {
  let current = start;
  return { now: () => current, advance: (ms) => (current += ms) };
}

/** Express and the WebSocket server sharing one ticket store, as in index.js. */
async function withServers(run, { config: overrides = {}, redisClient: injectedRedis, handler } = {}) {
  const config = { ...baseConfig, ...overrides };
  const redisClient = injectedRedis ?? Object.assign(createMemoryRedis(), { status: "ready" });
  const wsTickets = createWsTicketStore({ redisClient, ttlSeconds: config.WS_TICKET_TTL_SECONDS });
  const reached = [];
  const handleAuthenticatedConnection =
    handler ??
    ((client) => {
      reached.push(client.user);
      client.close(1000, "accepted");
    });
  const app = createApp({ redisClient, config, wsTickets });
  const http = app.listen(0, "127.0.0.1");
  await once(http, "listening");
  const wss = startWebSocketServer({ port: 0, config, handleAuthenticatedConnection, wsTickets });
  await once(wss, "listening");
  const httpUrl = `http://127.0.0.1:${http.address().port}`;
  const wsUrl = `ws://127.0.0.1:${wss.address().port}/ws`;
  const requestTicket = (cookieToken = issueJwt()) =>
    fetch(`${httpUrl}/ws-ticket`, {
      method: "POST",
      headers: cookieToken ? { cookie: `call_token=${cookieToken}` } : {},
    });
  const ticketFor = async (deviceId) => {
    const res = await requestTicket(issueJwt(deviceId));
    assert.equal(res.status, 200);
    return (await res.json()).ticket;
  };
  try {
    await run({ httpUrl, wsUrl, redisClient, reached, requestTicket, ticketFor, wsTickets });
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

const withTicket = (wsUrl, ticket, options) => new WebSocket(`${wsUrl}?ticket=${encodeURIComponent(ticket)}`, options);

test("POST /ws-ticket requires a valid auth cookie", async () => {
  await withServers(async ({ requestTicket }) => {
    const none = await requestTicket(null);
    assert.equal(none.status, 401);
    assert.deepEqual(await none.json(), { error: "no_cookie" });

    const forged = await requestTicket(issueJwt("device-123456", { secret: randomBytes(32).toString("hex") }));
    assert.equal(forged.status, 401);
    assert.deepEqual(await forged.json(), { error: "invalid_cookie" });

    const otherApp = await requestTicket(issueJwt("device-123456", { appId: "com.example.other" }));
    assert.equal(otherApp.status, 401);
    assert.deepEqual(await otherApp.json(), { error: "invalid_cookie" });
  });
});

test("POST /ws-ticket issues an opaque no-store ticket with the configured TTL", async () => {
  await withServers(
    async ({ requestTicket, redisClient }) => {
      const res = await requestTicket();
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "no-store");
      const body = await res.json();
      assert.deepEqual(Object.keys(body).sort(), ["expires_in", "ticket"]);
      assert.equal(body.expires_in, 12);
      assert.match(body.ticket, /^[A-Za-z0-9_-]{43}$/);
      assert.ok(!body.ticket.includes("."), "not a JWT");

      const ticketKeys = [...redisClient.ttls.keys()].filter((key) => key.startsWith("wsticket:"));
      assert.equal(ticketKeys.length, 1);
      assert.match(ticketKeys[0], /^wsticket:[0-9a-f]{64}$/);
      assert.equal(redisClient.ttls.get(ticketKeys[0]), 12);
      assert.deepEqual(JSON.parse(await redisClient.get(ticketKeys[0])), {
        app_id: baseConfig.APP_ID,
        device_id: "device-123456",
      });
    },
    { config: { WS_TICKET_TTL_SECONDS: 12 } }
  );
});

test("POST /ws-ticket is rate limited per installation", async () => {
  await withServers(async ({ requestTicket }) => {
    for (let i = 0; i < 3; i += 1) assert.equal((await requestTicket()).status, 200);
    const limited = await requestTicket();
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "60");
    assert.deepEqual(await limited.json(), { error: "rate_limited" });
    assert.equal((await requestTicket(issueJwt("device-other-1"))).status, 200, "other installations are unaffected");
  });
});

test("POST /ws-ticket answers 503 when the ticket cannot be stored", async () => {
  const redisClient = Object.assign(createMemoryRedis(), { status: "ready" });
  redisClient.set = async () => {
    throw Object.assign(new Error("down"), { code: "ECONNREFUSED" });
  };
  await withServers(
    async ({ requestTicket }) => {
      const res = await requestTicket();
      assert.equal(res.status, 503);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.deepEqual(await res.json(), { error: "ticket_unavailable" });
    },
    { redisClient }
  );
});

test("a ticket authenticates one WebSocket with the same owner as its JWT", async () => {
  await withServers(async ({ wsUrl, reached, ticketFor }) => {
    const ticket = await ticketFor("device-ticket-1");
    assert.deepEqual(await closeOf(withTicket(wsUrl, ticket)), { code: 1000, reason: "accepted" });

    // The same device over the legacy cookie path yields an identical owner.
    const legacy = new WebSocket(wsUrl, { headers: { cookie: `call_token=${issueJwt("device-ticket-1")}` } });
    assert.deepEqual(await closeOf(legacy), { code: 1000, reason: "accepted" });
    assert.deepEqual(reached, [
      { device_id: "device-ticket-1", app_id: baseConfig.APP_ID },
      { device_id: "device-ticket-1", app_id: baseConfig.APP_ID },
    ]);
  });
});

test("a reused ticket is rejected with 4001", async () => {
  await withServers(async ({ wsUrl, reached, ticketFor }) => {
    const ticket = await ticketFor("device-reuse-1");
    assert.equal((await closeOf(withTicket(wsUrl, ticket))).code, 1000);
    assert.deepEqual(await closeOf(withTicket(wsUrl, ticket)), { code: 4001, reason: "auth_failed" });
    assert.equal(reached.length, 1);
  });
});

test("concurrent handshakes with one ticket authenticate at most once", async () => {
  await withServers(async ({ wsUrl, reached, ticketFor }) => {
    const ticket = await ticketFor("device-race-1");
    const closes = await Promise.all(Array.from({ length: 4 }, () => closeOf(withTicket(wsUrl, ticket))));
    assert.equal(closes.filter((c) => c.code === 1000).length, 1);
    assert.equal(closes.filter((c) => c.code === 4001).length, 3);
    assert.equal(reached.length, 1);
  });
});

test("an expired ticket is rejected with 4001", async () => {
  const clock = makeClock();
  const redisClient = Object.assign(createMemoryRedis({ now: clock.now }), { status: "ready" });
  await withServers(
    async ({ wsUrl, reached, ticketFor }) => {
      const ticket = await ticketFor("device-expired-1");
      clock.advance(30_000);
      assert.deepEqual(await closeOf(withTicket(wsUrl, ticket)), { code: 4001, reason: "auth_failed" });
      assert.equal(reached.length, 0);
    },
    { redisClient }
  );
});

test("an unknown or malformed ticket is rejected and never falls back to the cookie", async () => {
  await withServers(async ({ wsUrl, reached }) => {
    const cookie = { headers: { cookie: `call_token=${issueJwt()}` } };
    for (const ticket of ["A".repeat(43), "not-a-ticket", ""]) {
      assert.deepEqual(await closeOf(withTicket(wsUrl, ticket, cookie)), { code: 4001, reason: "auth_failed" }, ticket);
    }
    const withToken = new WebSocket(`${wsUrl}?ticket=${"A".repeat(43)}&token=${issueJwt()}`);
    assert.deepEqual(await closeOf(withToken), { code: 4001, reason: "auth_failed" });
    assert.equal(reached.length, 0);
  });
});

test("a ticket is rejected when the server has no ticket store", async () => {
  const wss = startWebSocketServer({
    port: 0,
    config: baseConfig,
    handleAuthenticatedConnection: (client) => client.close(1000, "accepted"),
  });
  await once(wss, "listening");
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${wss.address().port}/ws?ticket=${"A".repeat(43)}`);
    assert.deepEqual(await closeOf(socket), { code: 4001, reason: "auth_failed" });
  } finally {
    await new Promise((resolve) => wss.close(resolve));
  }
});

test("a Redis failure while consuming closes with 1011 instead of authenticating", async () => {
  const redisClient = Object.assign(createMemoryRedis(), { status: "ready" });
  await withServers(
    async ({ wsUrl, reached, ticketFor }) => {
      const ticket = await ticketFor("device-down-1");
      redisClient.getdel = async () => {
        throw Object.assign(new Error("down"), { code: "ECONNREFUSED" });
      };
      assert.deepEqual(await closeOf(withTicket(wsUrl, ticket)), { code: 1011, reason: "auth_unavailable" });
      assert.equal(reached.length, 0);
    },
    { redisClient }
  );
});

test("WS_ALLOW_COOKIE_AUTH=false requires a ticket; the JWT no longer opens the socket", async () => {
  await withServers(
    async ({ wsUrl, reached, ticketFor }) => {
      const cookie = new WebSocket(wsUrl, { headers: { cookie: `call_token=${issueJwt()}` } });
      assert.deepEqual(await closeOf(cookie), { code: 4001, reason: "auth_required" });
      const query = new WebSocket(`${wsUrl}?token=${encodeURIComponent(issueJwt())}`);
      assert.deepEqual(await closeOf(query), { code: 4001, reason: "auth_required" });
      assert.equal(reached.length, 0);

      const ticket = await ticketFor("device-strict-1");
      assert.deepEqual(await closeOf(withTicket(wsUrl, ticket)), { code: 1000, reason: "accepted" });
      assert.deepEqual(reached, [{ device_id: "device-strict-1", app_id: baseConfig.APP_ID }]);
    },
    { config: { WS_ALLOW_COOKIE_AUTH: false } }
  );
});

test("the cookie and ?token= paths keep working by default", async () => {
  await withServers(async ({ wsUrl, reached }) => {
    const cookie = new WebSocket(wsUrl, { headers: { cookie: `call_token=${issueJwt("device-legacy-1")}` } });
    assert.deepEqual(await closeOf(cookie), { code: 1000, reason: "accepted" });
    const query = new WebSocket(`${wsUrl}?token=${encodeURIComponent(issueJwt("device-legacy-2"))}`);
    assert.deepEqual(await closeOf(query), { code: 1000, reason: "accepted" });
    assert.deepEqual(
      reached.map((user) => user.device_id),
      ["device-legacy-1", "device-legacy-2"]
    );
  });
});

/** A real `ws` client that records parsed frames and can await a predicate. */
async function openClient(url, options) {
  const socket = new WebSocket(url, options);
  const received = [];
  const waiters = new Set();
  socket.on("message", (data) => {
    received.push(JSON.parse(data.toString()));
    for (const waiter of [...waiters]) waiter();
  });
  await once(socket, "open");
  return {
    socket,
    received,
    send: (message) => socket.send(JSON.stringify(message)),
    waitFor(predicate, description) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), 5_000);
        const check = () => {
          const match = received.find(predicate);
          if (!match) return;
          clearTimeout(timer);
          waiters.delete(check);
          resolve(match);
        };
        waiters.add(check);
        check();
      });
    },
  };
}

test("resume owner binding holds across cookie and ticket connections", async () => {
  const harness = createSessionHarness();
  await withServers(
    async ({ wsUrl, ticketFor }) => {
      // An older client creates the session with the cookie.
      const owner = await openClient(wsUrl, { headers: { cookie: `call_token=${issueJwt("device-owner-1")}` } });
      owner.send({ context: { ...CANDIDATE_CONTEXT, capabilities: ["resume"] } });
      const { session } = await owner.waitFor((m) => m.session, "the session ID");
      await harness.waitUntil(() => harness.generator.calls.length === 1, "the intro call");
      harness.generator.calls[0].resolve("Intro.");
      await owner.waitFor((m) => m.ai_reply, "the intro");
      owner.socket.terminate();
      await harness.waitUntil(
        () => harness.sessions.get(session.id)?.state === SESSION_STATE.DISCONNECTED,
        "the disconnect"
      );

      // A ticket for another installation cannot take the session.
      const intruder = await openClient(withTicketUrl(wsUrl, await ticketFor("device-intruder-1")));
      intruder.send({ resume: { sessionId: session.id, lastSeq: 0 } });
      await intruder.waitFor((m) => m.error === "resume_rejected", "the rejection");
      intruder.socket.close();

      // A fresh ticket for the owning installation resumes it.
      const resumed = await openClient(withTicketUrl(wsUrl, await ticketFor("device-owner-1")));
      resumed.send({ resume: { sessionId: session.id, lastSeq: 0 } });
      await resumed.waitFor((m) => m.resumed, "the resume acknowledgement");
      assert.equal(harness.sessions.get(session.id).state, SESSION_STATE.ACTIVE);
      resumed.socket.close();
    },
    { handler: harness.handleConnection }
  );
});

function withTicketUrl(wsUrl, ticket) {
  return `${wsUrl}?ticket=${encodeURIComponent(ticket)}`;
}
