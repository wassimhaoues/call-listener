// services/audioCommandGuards.js
// Validation for values passed as arguments to SoundVolumeView and the
// VB-Cable installer. Device IDs come from SoundVolumeView's own CSV export or
// from the pending-restore state file on disk, so they are checked before use.
const path = require("node:path");

const MAX_DEVICE_ID_LENGTH = 256;
// Printable characters seen in SoundVolumeView "Command-Line Friendly ID"
// values, e.g. "VB-Audio Virtual Cable\Device\CABLE Input\Render".
const DEVICE_ID_PATTERN = /^[\p{L}\p{N} _.,()&#'+:{}[\]\\-]+$/u;

/** True when `value` is safe to pass as a SoundVolumeView device argument. */
function isSafeDeviceId(value) {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_DEVICE_ID_LENGTH) return false;
  // A leading "/" or "-" would be parsed as a command-line switch.
  if (value.startsWith("/") || value.startsWith("-")) return false;
  return DEVICE_ID_PATTERN.test(value);
}

function assertDeviceId(value) {
  if (!isSafeDeviceId(value)) {
    throw new TypeError("Refusing to use an unexpected audio device identifier");
  }
  return value;
}

/** Require an absolute path whose file name matches `expectedName` (case-insensitive). */
function assertExecutablePath(value, expectedName) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new TypeError(`${expectedName} path must be absolute`);
  }
  if (path.basename(value).toLowerCase() !== expectedName.toLowerCase()) {
    throw new TypeError(`Unexpected executable; expected ${expectedName}`);
  }
  return value;
}

module.exports = {
  MAX_DEVICE_ID_LENGTH,
  assertDeviceId,
  assertExecutablePath,
  isSafeDeviceId,
};
