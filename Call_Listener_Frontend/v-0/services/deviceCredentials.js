// services/deviceCredentials.js
// The installation's sign-in credentials: the persisted installation ID and a
// random secret kept encrypted with Electron safeStorage (Windows DPAPI, the
// macOS Keychain, or the Linux secret service). The backend binds the secret
// to the ID on first use (services/auth/deviceEnrollment.js), so knowing an
// installation ID alone no longer yields a token for it.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { getOrCreateInstallationId } = require("./installationId");

const SECRET_FILE = "device-secret.bin";
const ID_FILE = "installation-id";
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

function newSecret() {
  return crypto.randomBytes(32).toString("base64url");
}

function encryptionAvailable(safeStorage) {
  try {
    return Boolean(safeStorage?.isEncryptionAvailable?.());
  } catch {
    return false;
  }
}

/**
 * @returns {{ deviceId: string, deviceSecret?: string, storage: "os" | "unavailable", reset: boolean }}
 *   `deviceSecret` is undefined when the OS store is unavailable; the client
 *   then signs in as before (accepted while the backend does not require
 *   enrollment). `reset` is true when an unreadable secret forced a new
 *   installation identity.
 */
function getOrCreateDeviceCredentials({ userDataDir, safeStorage, log = console } = {}) {
  if (!userDataDir) throw new TypeError("userDataDir is required");
  if (!encryptionAvailable(safeStorage)) {
    return { deviceId: getOrCreateInstallationId(userDataDir), storage: "unavailable", reset: false };
  }
  const secretPath = path.join(userDataDir, SECRET_FILE);
  let reset = false;
  if (fs.existsSync(secretPath)) {
    try {
      const secret = safeStorage.decryptString(fs.readFileSync(secretPath));
      if (SECRET_PATTERN.test(secret)) {
        return { deviceId: getOrCreateInstallationId(userDataDir), deviceSecret: secret, storage: "os", reset: false };
      }
    } catch {}
    // The secret exists but cannot be read (OS key changed, file copied from
    // another computer). The backend would refuse this ID without it, so start
    // over as a new installation instead of locking the candidate out.
    log?.warn?.("[credentials] stored device secret unreadable; creating a new installation identity");
    fs.rmSync(path.join(userDataDir, ID_FILE), { force: true });
    reset = true;
  }
  // Otherwise: a new installation, or one from before enrollment that keeps
  // its ID and enrolls with this new secret.
  const deviceId = getOrCreateInstallationId(userDataDir);
  const secret = newSecret();
  fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(secretPath, safeStorage.encryptString(secret), { mode: 0o600 });
  return { deviceId, deviceSecret: secret, storage: "os", reset };
}

module.exports = { getOrCreateDeviceCredentials, SECRET_FILE };
