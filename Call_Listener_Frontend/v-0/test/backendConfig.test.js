import { describe, expect, it } from "vitest";

const { resolveBackendConfig } = require("../services/backendConfig.js");
const packageJson = require("../package.json");

describe("resolveBackendConfig", () => {
  it("uses the packaged host over HTTPS/WSS on 443 in a packaged build", () => {
    expect(resolveBackendConfig({ env: {}, isDev: false, packageJson })).toEqual({
      host: packageJson.callBackend.host,
      protocol: "https",
      port: 443,
      wsProtocol: "wss",
      wsPort: 443,
    });
  });

  it("defaults to the local backend in development and honours CALL_* overrides", () => {
    expect(resolveBackendConfig({ env: {}, isDev: true, packageJson })).toMatchObject({ host: "127.0.0.1", port: 3000, wsPort: 4000 });
    expect(resolveBackendConfig({ env: { CALL_HOST: "api.example.test", CALL_PORT: "8443" }, isDev: false, packageJson })).toMatchObject({
      host: "api.example.test",
      port: 8443,
    });
  });

  it("refuses to start without a valid host", () => {
    expect(() => resolveBackendConfig({ env: {}, isDev: false, packageJson: {} })).toThrow(/callBackend.host/);
    expect(() => resolveBackendConfig({ env: {}, isDev: false, packageJson: { callBackend: { host: "https://x/y" } } })).toThrow();
  });

  it("ships a configured host", () => {
    expect(packageJson.callBackend.host).toMatch(/^[a-z0-9.-]+$/);
  });
});
