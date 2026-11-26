import { describe, expect, it } from "vitest";

const { AuthManager, WS_TICKET_REQUEST_TIMEOUT_MS } = require("../services/auth.js");

const TICKET = "Zm9vYmFyYmF6cXV4LXRpY2tldC0wMTIzNDU2Nzg5X2E"; // 43 base64url characters

/**
 * Fake `http`/`https` client. Each request takes the next scripted answer:
 * `{ statusCode, body }`, or `"hang"` for a server that never answers.
 */
function makeScriptedRequestClient(answers) {
  const requests = [];
  return {
    requests,
    request(options, onResponse) {
      const answer = answers[requests.length];
      const req = {
        options,
        written: "",
        destroyedWith: undefined,
        on: () => req,
        write(chunk) {
          req.written += chunk;
        },
        end() {
          if (answer === "hang" || answer === undefined) return;
          const handlers = {};
          onResponse({ statusCode: answer.statusCode, on: (event, handler) => { handlers[event] = handler; } });
          const body = answer.body ?? {};
          handlers.data(typeof body === "string" ? body : JSON.stringify(body));
          handlers.end();
        },
        destroy(err) {
          req.destroyedWith = err;
        },
      };
      requests.push(req);
      return req;
    },
  };
}

function makeAuth(requestClient, extra = {}) {
  const cookies = [];
  const auth = new AuthManager({
    requestClient,
    appId: "com.coworky.calllistener",
    backendHost: "call.example.test",
    electronSession: { cookies: { set: async (cookie) => cookies.push(cookie) } },
    deviceId: "44d8a725-37db-4cc2-82ed-6d9e23c0db98",
    ...extra,
  });
  auth.token = "main-process-only-token";
  auth.cookies = cookies;
  return auth;
}

const ticketAnswer = (ticket = TICKET) => ({ statusCode: 200, body: { ticket, expires_in: 30 } });

describe("makeSignedWsUrl with WebSocket tickets", () => {
  it("posts to /ws-ticket with the main-process cookie and returns a ticket URL", async () => {
    const requestClient = makeScriptedRequestClient([ticketAnswer()]);
    const auth = makeAuth(requestClient);

    const url = await auth.makeSignedWsUrl();

    expect(url).toBe(`wss://call.example.test/ws?ticket=${TICKET}`);
    expect(url).not.toContain("main-process-only-token");
    expect(requestClient.requests).toHaveLength(1);
    expect(requestClient.requests[0].options).toMatchObject({
      hostname: "call.example.test",
      port: 443,
      path: "/ws-ticket",
      method: "POST",
      headers: { Cookie: "call_token=main-process-only-token" },
      timeout: WS_TICKET_REQUEST_TIMEOUT_MS,
    });
  });

  it("fetches a fresh ticket on every call, so each reconnect attempt gets its own", async () => {
    const second = "c2Vjb25kLXRpY2tldC1zZWNvbmQtdGlja2V0LXNlY29uZA";
    const auth = makeAuth(makeScriptedRequestClient([ticketAnswer(), ticketAnswer(second)]));

    expect(await auth.makeSignedWsUrl()).toBe(`wss://call.example.test/ws?ticket=${TICKET}`);
    expect(await auth.makeSignedWsUrl()).toBe(`wss://call.example.test/ws?ticket=${second}`);
  });

  it("uses the configured development WebSocket port", async () => {
    const auth = makeAuth(makeScriptedRequestClient([ticketAnswer()]), {
      backendHost: "127.0.0.1",
      backendProtocol: "http",
      backendPort: 3000,
      wsProtocol: "ws",
      wsPort: 4000,
    });
    await expect(auth.makeSignedWsUrl()).resolves.toBe(`ws://127.0.0.1:4000/ws?ticket=${TICKET}`);
  });

  it.each([404, 426])("falls back to the cookie-authenticated URL when an older server answers %i", async (statusCode) => {
    const auth = makeAuth(makeScriptedRequestClient([{ statusCode, body: "Upgrade Required" }]));
    await expect(auth.makeSignedWsUrl()).resolves.toBe("wss://call.example.test/ws");
  });

  it.each([429, 500, 503])("does not fall back to the cookie when the server answers %i", async (statusCode) => {
    const auth = makeAuth(makeScriptedRequestClient([{ statusCode, body: { error: "rate_limited" } }]));
    await expect(auth.makeSignedWsUrl()).rejects.toMatchObject({ statusCode });
  });

  it("refreshes a refused cookie once and retries the ticket", async () => {
    const requestClient = makeScriptedRequestClient([
      { statusCode: 401, body: { error: "invalid_cookie" } },
      { statusCode: 200, body: { token: "fresh-token", expires_in: 900 } },
      ticketAnswer(),
    ]);
    const auth = makeAuth(requestClient);

    await expect(auth.makeSignedWsUrl()).resolves.toBe(`wss://call.example.test/ws?ticket=${TICKET}`);
    expect(requestClient.requests.map((req) => req.options.path)).toEqual(["/ws-ticket", "/auth/token", "/ws-ticket"]);
    expect(requestClient.requests[2].options.headers.Cookie).toBe("call_token=fresh-token");
    expect(auth.cookies.at(-1)).toMatchObject({ name: "call_token", value: "fresh-token" });
    clearTimeout(auth.refreshTimer);
  });

  it("rejects when the cookie is still refused after one refresh", async () => {
    const requestClient = makeScriptedRequestClient([
      { statusCode: 401, body: { error: "invalid_cookie" } },
      { statusCode: 200, body: { token: "fresh-token", expires_in: 900 } },
      { statusCode: 401, body: { error: "invalid_cookie" } },
    ]);
    const auth = makeAuth(requestClient);

    await expect(auth.makeSignedWsUrl()).rejects.toMatchObject({ statusCode: 401 });
    expect(requestClient.requests).toHaveLength(3);
    clearTimeout(auth.refreshTimer);
  });

  it.each([
    ["no ticket", {}],
    ["a non-string ticket", { ticket: 42 }],
    ["a ticket with URL characters", { ticket: "abc/def?x=1&token=leak-leak-leak" }],
    ["a ticket that is too short", { ticket: "short" }],
    ["invalid JSON", "<html>"],
  ])("rejects a 200 answer with %s", async (_name, body) => {
    const auth = makeAuth(makeScriptedRequestClient([{ statusCode: 200, body }]));
    await expect(auth.makeSignedWsUrl()).rejects.toThrow(/invalid/);
  });

  it("bounds the ticket request with a deadline", async () => {
    const requestClient = makeScriptedRequestClient(["hang"]);
    const auth = makeAuth(requestClient);

    await expect(auth.makeSignedWsUrl({ timeoutMs: 20 })).rejects.toMatchObject({ code: "ETIMEDOUT" });
    expect(requestClient.requests[0].destroyedWith?.code).toBe("ETIMEDOUT");
  });

  it("obtains a token first when none is cached", async () => {
    const requestClient = makeScriptedRequestClient([
      { statusCode: 200, body: { token: "first-token", expires_in: 900 } },
      ticketAnswer(),
    ]);
    const auth = makeAuth(requestClient);
    auth.token = null;

    await expect(auth.makeSignedWsUrl()).resolves.toBe(`wss://call.example.test/ws?ticket=${TICKET}`);
    expect(requestClient.requests[1].options.headers.Cookie).toBe("call_token=first-token");
    clearTimeout(auth.refreshTimer);
  });
});

describe("revoked installations", () => {
  const { classifyAuthFailure, AUTH_FAILURE } = require("../services/authFailure.js");
  const revoked = { statusCode: 403, body: { error: "device_revoked" } };

  it("rejects the ticket request with device_revoked and no response body", async () => {
    const auth = makeAuth(makeScriptedRequestClient([revoked]));

    const error = await auth.makeSignedWsUrl().catch((caught) => caught);
    expect(error).toMatchObject({ code: "device_revoked", statusCode: 403, message: "device_revoked" });
    expect(classifyAuthFailure(error)).toBe(AUTH_FAILURE.REVOKED);
  });

  it("rejects the startup token request with device_revoked", async () => {
    const auth = makeAuth(makeScriptedRequestClient([revoked]));
    auth.token = null;

    const error = await auth.ensure().catch((caught) => caught);
    expect(error).toMatchObject({ code: "device_revoked", message: "device_revoked" });
    expect(classifyAuthFailure(error)).toBe(AUTH_FAILURE.REVOKED);
    expect(auth.cookies).toHaveLength(0);
  });

  it("keeps other 403 answers as generic HTTP failures", async () => {
    const auth = makeAuth(makeScriptedRequestClient([{ statusCode: 403, body: { error: "forbidden" } }]));

    const error = await auth.makeSignedWsUrl().catch((caught) => caught);
    expect(error.code).toBeUndefined();
    expect(error.statusCode).toBe(403);
    expect(classifyAuthFailure(error)).toBe(AUTH_FAILURE.HTTP);
  });
});
