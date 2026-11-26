import { describe, expect, it } from "vitest";

const { AUTH_APP_ID, WINDOWS_APP_USER_MODEL_ID } = require("../services/appIdentity.js");
const packageJson = require("../package.json");

describe("app identity", () => {
  it("uses the installer's appId as the Windows AppUserModelID", () => {
    // electron-builder writes build.appId into the shortcut's AUMID.
    expect(WINDOWS_APP_USER_MODEL_ID).toBe(packageJson.build.appId);
  });

  it("keeps the backend application ID separate and unchanged", () => {
    expect(AUTH_APP_ID).toBe("com.coworky.calllistener");
  });
});
