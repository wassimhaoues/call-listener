import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { AuthManager } = require("../services/auth.js");
const { getOrCreateInstallationId } = require("../services/installationId.js");

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("persists an opaque installation ID instead of deriving identity from a hostname", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "call-listener-test-"));
  tempDirs.push(userDataDir);

  const first = getOrCreateInstallationId(userDataDir);
  const second = getOrCreateInstallationId(userDataDir);

  expect(first).toMatch(/^[0-9a-f-]{36}$/i);
  expect(second).toBe(first);
  expect(fs.readFileSync(path.join(userDataDir, "installation-id"), "utf8").trim()).toBe(first);
});

it("returns a cookie-authenticated WebSocket URL without a bearer token", async () => {
  const auth = new AuthManager({
    requestClient: {},
    appId: "com.coworky.calllistener",
    backendHost: "call.example.test",
    electronSession: { cookies: { set: async () => {} } },
    deviceId: "44d8a725-37db-4cc2-82ed-6d9e23c0db98",
  });
  auth.token = "a-secret-that-must-not-reach-the-renderer";

  await expect(auth.makeSignedWsUrl()).resolves.toBe("wss://call.example.test/ws");
});

it("requires an explicit installation ID", () => {
  expect(() => new AuthManager({
    requestClient: {},
    appId: "com.coworky.calllistener",
    backendHost: "call.example.test",
    electronSession: { cookies: { set: async () => {} } },
  })).toThrow(/deviceId is required/);
});

it("uses localhost HTTP and WS ports when explicitly configured for development", async () => {
  const auth = new AuthManager({
    requestClient: {},
    appId: "com.coworky.calllistener",
    backendHost: "127.0.0.1",
    backendProtocol: "http",
    backendPort: 3000,
    wsProtocol: "ws",
    wsPort: 4000,
    electronSession: { cookies: { set: async () => {} } },
    deviceId: "44d8a725-37db-4cc2-82ed-6d9e23c0db98",
  });
  auth.token = "a-local-only-token";

  await expect(auth.makeSignedWsUrl()).resolves.toBe("ws://127.0.0.1:4000/ws");
});

it("fetches the model catalog with the main-process cookie and returns only catalog fields", async () => {
  let requestOptions;
  const requestClient = {
    request(options, onResponse) {
      requestOptions = options;
      const handlers = {};
      const res = {
        statusCode: 200,
        on: (event, handler) => { handlers[event] = handler; },
      };
      return {
        on() {},
        end() {
          onResponse(res);
          handlers.data(JSON.stringify({
            provider: "openrouter",
            defaultModel: "openai/gpt-5.6-luna",
            models: [
              { id: "openai/gpt-5.6-luna", name: "Luna", availability: "available", pricing: { x: 1 } },
              { id: "removed/model", availability: "bogus" },
              { name: "no id" },
            ],
          }));
          handlers.end();
        },
      };
    },
  };
  const auth = new AuthManager({
    requestClient,
    appId: "com.coworky.calllistener",
    backendHost: "call.example.test",
    electronSession: { cookies: { set: async () => {} } },
    deviceId: "44d8a725-37db-4cc2-82ed-6d9e23c0db98",
  });
  auth.token = "main-process-only-token";

  await expect(auth.fetchModels()).resolves.toEqual({
    provider: "openrouter",
    defaultModel: "openai/gpt-5.6-luna",
    models: [
      { id: "openai/gpt-5.6-luna", name: "Luna", availability: "available", isDefault: true },
      { id: "removed/model", name: "removed/model", availability: "unknown", isDefault: false },
    ],
  });
  expect(requestOptions).toMatchObject({
    hostname: "call.example.test",
    path: "/models",
    method: "GET",
    headers: { Cookie: "call_token=main-process-only-token" },
  });
});

// A request client whose server accepts the request but never answers.
function makeHangingRequestClient() {
  const requests = [];
  return {
    requests,
    request(options) {
      const req = {
        options,
        destroyedWith: undefined,
        on() {
          return req;
        },
        write() {},
        end() {},
        destroy(err) {
          req.destroyedWith = err;
        },
      };
      requests.push(req);
      return req;
    },
  };
}

const makeAuth = (requestClient, extra = {}) =>
  new AuthManager({
    requestClient,
    appId: "com.coworky.calllistener",
    backendHost: "call.example.test",
    electronSession: { cookies: { set: async () => {} } },
    deviceId: "44d8a725-37db-4cc2-82ed-6d9e23c0db98",
    ...extra,
  });

it("bounds the startup token request and classifies the timeout", async () => {
  const { classifyAuthFailure, AUTH_FAILURE } = require("../services/authFailure.js");
  const { AUTH_REQUEST_TIMEOUT_MS } = require("../services/auth.js");
  expect(AUTH_REQUEST_TIMEOUT_MS).toBe(10_000);

  const requestClient = makeHangingRequestClient();
  const auth = makeAuth(requestClient, { requestTimeoutMs: 20 });

  const error = await auth.ensure().catch((e) => e);
  expect(error).toBeInstanceOf(Error);
  expect(error.code).toBe("ETIMEDOUT");
  expect(requestClient.requests[0].destroyedWith).toBe(error);
  expect(auth.token).toBeNull();
  expect(classifyAuthFailure(error, { online: true })).toBe(AUTH_FAILURE.SERVER_UNREACHABLE);
  expect(classifyAuthFailure(error, { online: false })).toBe(AUTH_FAILURE.OFFLINE);
});

it("bounds the model catalog request even when the socket never idles out", async () => {
  const requestClient = makeHangingRequestClient();
  const auth = makeAuth(requestClient);
  auth.token = "main-process-only-token";

  await expect(auth.fetchModels({ timeoutMs: 20 })).rejects.toMatchObject({ code: "ETIMEDOUT" });
  expect(requestClient.requests[0].destroyedWith?.code).toBe("ETIMEDOUT");
});
