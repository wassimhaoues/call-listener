import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { getOrCreateDeviceCredentials, SECRET_FILE } = require("../services/deviceCredentials.js");

// A reversible stand-in for Electron safeStorage (the real one uses OS keys).
function fakeSafeStorage({ available = true, key = "k1" } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (text) => Buffer.from(`${key}:${Buffer.from(text).toString("base64")}`),
    decryptString: (buffer) => {
      const [usedKey, data] = buffer.toString().split(":");
      if (usedKey !== key) throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
      return Buffer.from(data, "base64").toString();
    },
  };
}

const dirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cl-creds-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("getOrCreateDeviceCredentials", () => {
  it("creates and then reuses an ID and an encrypted secret", () => {
    const dir = tempDir();
    const first = getOrCreateDeviceCredentials({ userDataDir: dir, safeStorage: fakeSafeStorage() });
    expect(first.storage).toBe("os");
    expect(first.deviceSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const onDisk = fs.readFileSync(path.join(dir, SECRET_FILE)).toString();
    expect(onDisk).not.toContain(first.deviceSecret);
    const again = getOrCreateDeviceCredentials({ userDataDir: dir, safeStorage: fakeSafeStorage() });
    expect(again).toEqual({ ...first, reset: false });
  });

  it("keeps a pre-enrollment installation ID and adds a secret", () => {
    const dir = tempDir();
    const legacyId = "44d8a725-37db-4cc2-82ed-6d9e23c0db98";
    fs.writeFileSync(path.join(dir, "installation-id"), `${legacyId}\n`);
    const credentials = getOrCreateDeviceCredentials({ userDataDir: dir, safeStorage: fakeSafeStorage() });
    expect(credentials.deviceId).toBe(legacyId);
    expect(credentials.deviceSecret).toBeTruthy();
  });

  it("starts a new identity when the stored secret cannot be decrypted", () => {
    const dir = tempDir();
    const first = getOrCreateDeviceCredentials({ userDataDir: dir, safeStorage: fakeSafeStorage({ key: "old" }) });
    const warnings = [];
    const moved = getOrCreateDeviceCredentials({
      userDataDir: dir,
      safeStorage: fakeSafeStorage({ key: "new" }),
      log: { warn: (line) => warnings.push(line) },
    });
    expect(moved.reset).toBe(true);
    expect(moved.deviceId).not.toBe(first.deviceId);
    expect(moved.deviceSecret).not.toBe(first.deviceSecret);
    expect(warnings.join("\n")).not.toContain(first.deviceSecret);
  });

  it("signs in without a secret when the OS store is unavailable", () => {
    const dir = tempDir();
    const credentials = getOrCreateDeviceCredentials({ userDataDir: dir, safeStorage: fakeSafeStorage({ available: false }) });
    expect(credentials.storage).toBe("unavailable");
    expect(credentials.deviceSecret).toBeUndefined();
    expect(fs.existsSync(path.join(dir, SECRET_FILE))).toBe(false);
  });
});
