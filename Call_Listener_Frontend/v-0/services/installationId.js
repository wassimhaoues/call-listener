const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const FILE_NAME = "installation-id";
const ID_PATTERN = /^[0-9a-f-]{36}$/i;

/**
 * Persist an opaque installation identifier. It is not an account credential;
 * it only avoids using a hostname as the device identity sent to the backend.
 */
function getOrCreateInstallationId(userDataDir) {
  if (!userDataDir) throw new TypeError("userDataDir is required");
  const filePath = path.join(userDataDir, FILE_NAME);

  try {
    const existing = fs.readFileSync(filePath, "utf8").trim();
    if (ID_PATTERN.test(existing)) return existing;
  } catch {}

  fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  const id = crypto.randomUUID();
  fs.writeFileSync(filePath, `${id}\n`, { mode: 0o600 });
  return id;
}

module.exports = { getOrCreateInstallationId };
