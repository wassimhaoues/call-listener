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
