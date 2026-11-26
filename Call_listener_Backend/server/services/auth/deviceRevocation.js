import { createHash } from "node:crypto";

/**
 * Operator deny-list of installations (device IDs).
 *
 * Redis stores only `revoked:<sha256(device_id) hex>` -> `{ reason, revoked_at }`
 * with no expiry, so a Redis dump never reveals a raw installation ID. The
 * reason is a short operator code (for example `abuse-ticket-142`), limited to
 * a small character set so it cannot hold an email address or free text.
 *
 * `isRevoked`, `revoke`, `restore` and `lookup` reject when Redis fails; they
 * are for operators and tests. `checkAccess` is the request hot path: it never
 * rejects, logs Redis failures, and lets the caller fail open (default) or
 * closed (`failClosed`).
 */
export const REVOKED_PREFIX = "revoked:";
export const DEVICE_ID_MIN_LENGTH = 6;
export const DEVICE_ID_MAX_LENGTH = 256;
export const REASON_MAX_LENGTH = 120;
export const DEFAULT_REVOCATION_REASON = "operator";
export const DEFAULT_LOOKUP_TIMEOUT_MS = 1_000;
const REASON_PATTERN = /^[A-Za-z0-9 _.:#/-]+$/;
const FINGERPRINT_LENGTH = 12;

export function isDeviceId(value) {
  return (
    typeof value === "string" &&
    value.length >= DEVICE_ID_MIN_LENGTH &&
    value.length <= DEVICE_ID_MAX_LENGTH
  );
}

function hashDeviceId(deviceId) {
  return createHash("sha256").update(deviceId).digest("hex");
}

/** Redis key for a device; the raw device ID never appears in Redis. */
export function revocationKey(deviceId) {
  return REVOKED_PREFIX + hashDeviceId(deviceId);
}

/** Short, non-reversible label for logs and operator output. */
export function deviceFingerprint(deviceId) {
  return hashDeviceId(deviceId).slice(0, FINGERPRINT_LENGTH);
}

/**
 * Normalize an operator reason. Returns the trimmed reason, the default when
 * none is given, or throws a TypeError for a reason that is too long or uses
 * characters outside `A-Z a-z 0-9 space _ . : # / -`.
 */
export function normalizeReason(reason) {
  if (reason === undefined || reason === null) return DEFAULT_REVOCATION_REASON;
  if (typeof reason !== "string") throw new TypeError("reason must be a string");
  const trimmed = reason.trim().replaceAll(/ {2,}/g, " ");
  if (!trimmed) return DEFAULT_REVOCATION_REASON;
  if (trimmed.length > REASON_MAX_LENGTH) {
    throw new TypeError(`reason must be at most ${REASON_MAX_LENGTH} characters`);
  }
  if (!REASON_PATTERN.test(trimmed)) {
    throw new TypeError("reason may only use letters, digits, spaces and _ . : # / -");
  }
  return trimmed;
}

function assertDeviceId(deviceId) {
  if (!isDeviceId(deviceId)) {
    throw new TypeError(
      `device id must be a string of ${DEVICE_ID_MIN_LENGTH} to ${DEVICE_ID_MAX_LENGTH} characters`
    );
  }
}

function parseRecord(raw) {
  try {
    const parsed = JSON.parse(raw);
    return {
      reason: typeof parsed?.reason === "string" ? parsed.reason : DEFAULT_REVOCATION_REASON,
      revokedAt: typeof parsed?.revoked_at === "string" ? parsed.revoked_at : null,
    };
  } catch {
    return { reason: DEFAULT_REVOCATION_REASON, revokedAt: null };
  }
}

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("revocation lookup timed out");
      error.code = "ETIMEDOUT";
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createDeviceRevocation({
  redisClient,
  failClosed = false,
  lookupTimeoutMs = DEFAULT_LOOKUP_TIMEOUT_MS,
  now = () => new Date(),
  log,
} = {}) {
  if (!redisClient) throw new TypeError("redisClient is required");
  if (typeof failClosed !== "boolean") throw new TypeError("failClosed must be a boolean");
  if (!Number.isInteger(lookupTimeoutMs) || lookupTimeoutMs < 1) {
    throw new TypeError("lookupTimeoutMs must be a positive integer");
  }

  async function lookup(deviceId) {
    assertDeviceId(deviceId);
    const raw = await withTimeout(redisClient.get(revocationKey(deviceId)), lookupTimeoutMs);
    if (raw === null || raw === undefined) return { revoked: false };
    return { revoked: true, ...parseRecord(raw) };
  }

  return {
    failClosed,

    /** The stored revocation record, `{ revoked: false }` when none. Rejects on Redis failure. */
    lookup,

    /** Whether the device is on the deny-list. Rejects on Redis failure. */
    async isRevoked(deviceId) {
      return (await lookup(deviceId)).revoked;
    },

    /** Add the device to the deny-list. Returns `{ fingerprint, reason, revokedAt }`. */
    async revoke(deviceId, { reason } = {}) {
      assertDeviceId(deviceId);
      const record = { reason: normalizeReason(reason), revoked_at: now().toISOString() };
      await redisClient.set(revocationKey(deviceId), JSON.stringify(record));
      return { fingerprint: deviceFingerprint(deviceId), reason: record.reason, revokedAt: record.revoked_at };
    },

    /** Remove the device from the deny-list. Resolves true when it was revoked. */
    async restore(deviceId) {
      assertDeviceId(deviceId);
      return (await redisClient.del(revocationKey(deviceId))) > 0;
    },

    /**
     * Hot-path decision for an authenticated device. Resolves
     * `{ allowed: true }`, `{ allowed: false, error: "device_revoked" }`, or,
     * when Redis fails and `failClosed` is set,
     * `{ allowed: false, error: "revocation_unavailable" }`. Never rejects.
     */
    async checkAccess(deviceId) {
      if (!isDeviceId(deviceId)) return { allowed: true };
      try {
        const { revoked } = await lookup(deviceId);
        if (revoked) return { allowed: false, error: "device_revoked" };
        return { allowed: true };
      } catch (error) {
        const code = error?.code || "error";
        if (failClosed) {
          log?.warn?.(`Device revocation check unavailable (${code}); denying (fail-closed)`);
          return { allowed: false, error: "revocation_unavailable" };
        }
        log?.warn?.(`Device revocation check unavailable (${code}); allowing (fail-open)`);
        return { allowed: true };
      }
    },
  };
}
