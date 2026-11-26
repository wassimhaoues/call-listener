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

// A request client that answers once with the given status and JSON body.
function makeRespondingRequestClient(statusCode, body) {
  const requests = [];
  return {
    requests,
    request(options, onResponse) {
      const handlers = {};
      const req = {
        options,
        written: "",
        on() {
          return req;
        },
        write(chunk) {
          req.written += chunk;
        },
        end() {
          onResponse({ statusCode, on: (event, handler) => { handlers[event] = handler; } });
          handlers.data(typeof body === "string" ? body : JSON.stringify(body));
          handlers.end();
        },
        destroy() {},
      };
      requests.push(req);
      return req;
    },
  };
}

const preparationContext = {
  version: 1,
  candidate: { name: "Ada", skills: [], achievements: ["Led a migration"] },
  jobOffer: { title: "Engineer" },
  settings: { language: "en", model: "openai/test" },
};

it("posts the preparation context with the main-process cookie and whitelists the brief", async () => {
  const requestClient = makeRespondingRequestClient(200, {
    model: "openai/test",
    token: "must-not-leak",
    brief: {
      introduction: "  Hello  ",
      starExamples: [
        {
          requirement: "Migrations",
          evidenceIds: ["A1", 7, "E1"],
          situation: "s",
          task: "t",
          action: "a",
          result: "r",
          html: "<b>x</b>",
        },
      ],
      practiceTopics: ["Topic", 3, ""],
      questionsToAsk: Array.from({ length: 10 }, (_, index) => `Question ${index}`),
      missingEvidence: "not a list",
      extra: "dropped",
    },
  });
  const auth = makeAuth(requestClient);
  auth.token = "main-process-only-token";

  const result = await auth.fetchPreparationBrief(preparationContext, { model: "openai/test", language: "en" });

  expect(result).toEqual({
    model: "openai/test",
    brief: {
      introduction: "Hello",
      starExamples: [
        { requirement: "Migrations", evidenceIds: ["A1", "E1"], situation: "s", task: "t", action: "a", result: "r" },
      ],
      practiceTopics: ["Topic"],
      questionsToAsk: Array.from({ length: 6 }, (_, index) => `Question ${index}`),
      missingEvidence: [],
    },
  });
  const [req] = requestClient.requests;
  expect(req.options).toMatchObject({
    hostname: "call.example.test",
    path: "/preparation/brief",
    method: "POST",
    headers: { Cookie: "call_token=main-process-only-token", "Content-Type": "application/json" },
  });
  expect(JSON.parse(req.written)).toEqual({ context: preparationContext, model: "openai/test", language: "en" });
});

it("maps preparation HTTP errors to known codes only", async () => {
  const budget = makeAuth(makeRespondingRequestClient(429, { error: "preparation_budget_reached" }));
  budget.token = "t";
  await expect(budget.fetchPreparationBrief(preparationContext)).rejects.toMatchObject({
    code: "preparation_budget_reached",
    statusCode: 429,
  });

  const unknown = makeAuth(makeRespondingRequestClient(500, "<html>secret stack</html>"));
  unknown.token = "t";
  await expect(unknown.fetchPreparationBrief(preparationContext)).rejects.toMatchObject({
    code: "preparation_failed",
    statusCode: 500,
  });

  const invalid = makeAuth(makeRespondingRequestClient(200, { brief: { introduction: "" } }));
  invalid.token = "t";
  await expect(invalid.fetchPreparationBrief(preparationContext)).rejects.toMatchObject({ code: "preparation_failed" });
});

it("bounds the preparation request with its own deadline", async () => {
  const { PREPARATION_REQUEST_TIMEOUT_MS } = require("../services/auth.js");
  expect(PREPARATION_REQUEST_TIMEOUT_MS).toBe(50_000);
  const requestClient = makeHangingRequestClient();
  const auth = makeAuth(requestClient);
  auth.token = "main-process-only-token";

  await expect(auth.fetchPreparationBrief(preparationContext, { timeoutMs: 20 })).rejects.toMatchObject({
    code: "ETIMEDOUT",
  });
  expect(requestClient.requests[0].destroyedWith?.code).toBe("ETIMEDOUT");
  expect(requestClient.requests[0].options.timeout).toBe(20);
});
