import { createHash, timingSafeEqual } from "node:crypto";
import { deviceFingerprint } from "./deviceRevocation.js";

/**
 * Installation enrollment: binds each installation ID to a secret the desktop
 * keeps in the OS credential store, so knowing an installation ID is no
 * longer enough to obtain a token for it.
 *
 * Redis stores `enrolled:<sha256(device_id) hex>` -> `{ secret_sha256,
 * enrolled_at }` with no expiry; neither the raw ID nor the secret is stored.
 * The first `/auth/token` that presents a well-formed secret for an
 * unenrolled ID enrolls it (trust on first use, `SET NX` so concurrent first
 * uses cannot both win). After that the same secret is required.
 *
 * An installation that sends no secret (an older desktop build) is accepted
 * only while the ID is unenrolled and `required` is false. Redis failures are
 * fail-closed whenever a secret is involved or required, because accepting
 * would let anyone with the ID through; a legacy request with nothing to
 * verify is still allowed when enrollment is optional.
 */
export const ENROLLED_PREFIX = "enrolled:";
// 32 random bytes as base64url (43 characters); a little room for longer secrets.
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
export const DEFAULT_ENROLLMENT_TIMEOUT_MS = 1_000;

export const ENROLLMENT_ERROR = Object.freeze({
  INVALID: "device_secret_invalid",
  REQUIRED: "enrollment_required",
  UNAVAILABLE: "enrollment_unavailable",
});

export function isDeviceSecret(value) {
  return typeof value === "string" && SECRET_PATTERN.test(value);
}

const sha256 = (value) => createHash("sha256").update(value).digest();

export function enrollmentKey(deviceId) {
  return ENROLLED_PREFIX + sha256(deviceId).toString("hex");
}

function withTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("enrollment lookup timed out"), { code: "ETIMEDOUT" })), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function storedHash(raw) {
  try {
    const hex = JSON.parse(raw)?.secret_sha256;
    return typeof hex === "string" && /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, "hex") : null;
  } catch {
    return null;
  }
}

export function createDeviceEnrollment({
  redisClient,
  required = false,
  timeoutMs = DEFAULT_ENROLLMENT_TIMEOUT_MS,
  now = () => new Date(),
  log,
} = {}) {
  if (!redisClient) throw new TypeError("redisClient is required");

  async function verifyOrEnroll(deviceId, secret) {
    const key = enrollmentKey(deviceId);
    const raw = await withTimeout(redisClient.get(key), timeoutMs);
    if (raw === null || raw === undefined) {
      if (!isDeviceSecret(secret)) {
        return required ? { allowed: false, error: ENROLLMENT_ERROR.REQUIRED } : { allowed: true, enrolled: false };
      }
      const record = JSON.stringify({ secret_sha256: sha256(secret).toString("hex"), enrolled_at: now().toISOString() });
      const created = await withTimeout(redisClient.set(key, record, "NX"), timeoutMs);
      if (created === "OK") {
        log?.info?.(`🔐 Installation [${deviceFingerprint(deviceId)}] enrolled.`);
        return { allowed: true, enrolled: true, newlyEnrolled: true };
      }
      // Another first use won the race: verify against what it stored.
      return verifyOrEnroll(deviceId, secret);
    }
    const expected = storedHash(raw);
    if (!expected || !isDeviceSecret(secret) || !timingSafeEqual(expected, sha256(secret))) {
      log?.warn?.(`🚫 Installation [${deviceFingerprint(deviceId)}] presented a missing or wrong secret.`);
      return { allowed: false, error: ENROLLMENT_ERROR.INVALID };
    }
    return { allowed: true, enrolled: true };
  }

  return {
    required,

    /**
     * Request hot path; never rejects. `{ allowed: true, enrolled }` or
     * `{ allowed: false, error }` with an ENROLLMENT_ERROR code.
     */
    async check(deviceId, secret) {
      if (secret !== undefined && !isDeviceSecret(secret)) {
        return { allowed: false, error: ENROLLMENT_ERROR.INVALID };
      }
      try {
        return await verifyOrEnroll(deviceId, secret);
      } catch (error) {
        log?.warn?.(`Enrollment store unavailable (${error?.code || "error"})`);
        if (secret === undefined && !required) return { allowed: true, enrolled: false, unverified: true };
        return { allowed: false, error: ENROLLMENT_ERROR.UNAVAILABLE };
      }
    },

    /** Operator: whether an installation is enrolled (rejects on Redis errors). */
    async isEnrolled(deviceId) {
      return (await redisClient.get(enrollmentKey(deviceId))) !== null;
    },

    /** Operator: forget an enrollment so the installation can enroll again. */
    async reset(deviceId) {
      return (await redisClient.del(enrollmentKey(deviceId))) > 0;
    },
  };
}
