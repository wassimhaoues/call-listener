import { createHash, randomBytes as cryptoRandomBytes } from "node:crypto";

/**
 * Short-lived, single-use WebSocket tickets.
 *
 * A ticket is 256 random bits as base64url. Redis stores only its SHA-256 hash
 * (`wsticket:<hex>`) with the owner claims and a short TTL, so a Redis dump
 * cannot be replayed. Consuming a ticket deletes it atomically with GETDEL:
 * two connections presenting the same ticket can never both succeed.
 */
export const WS_TICKET_PREFIX = "wsticket:";
export const WS_TICKET_BYTES = 32;
export const DEFAULT_WS_TICKET_TTL_SECONDS = 30;
const MAX_WS_TICKET_TTL_SECONDS = 300;
const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const OWNER_FIELD_MAX = 256;

export function isWsTicketTtl(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_WS_TICKET_TTL_SECONDS;
}

/** Redis key for a ticket; the raw ticket never appears in Redis. */
export function wsTicketKey(ticket) {
  return `${WS_TICKET_PREFIX}${createHash("sha256").update(ticket).digest("hex")}`;
}

function isOwnerField(value) {
  return typeof value === "string" && value.length > 0 && value.length <= OWNER_FIELD_MAX;
}

function parseOwner(raw) {
  if (typeof raw !== "string") return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isOwnerField(parsed?.app_id) || !isOwnerField(parsed?.device_id)) return null;
  return { app_id: parsed.app_id, device_id: parsed.device_id };
}

export function createWsTicketStore({
  redisClient,
  ttlSeconds = DEFAULT_WS_TICKET_TTL_SECONDS,
  randomBytes = cryptoRandomBytes,
} = {}) {
  if (!redisClient) throw new TypeError("redisClient is required");
  if (!isWsTicketTtl(ttlSeconds)) {
    throw new TypeError(`ttlSeconds must be an integer between 1 and ${MAX_WS_TICKET_TTL_SECONDS}`);
  }

  return {
    ttlSeconds,

    /** Issue a ticket bound to `{ app_id, device_id }`. Rejects if Redis fails. */
    async issue({ app_id, device_id } = {}) {
      if (!isOwnerField(app_id) || !isOwnerField(device_id)) {
        throw new TypeError("ticket owner requires app_id and device_id");
      }
      const ticket = randomBytes(WS_TICKET_BYTES).toString("base64url");
      await redisClient.set(wsTicketKey(ticket), JSON.stringify({ app_id, device_id }), "EX", ttlSeconds);
      return { ticket, expiresIn: ttlSeconds };
    },

    /**
     * Atomically consume a ticket. Resolves the owner claims, or null for a
     * malformed, unknown, expired, or already used ticket. Rejects only when
     * Redis itself fails.
     */
    async consume(ticket) {
      if (typeof ticket !== "string" || !TICKET_PATTERN.test(ticket)) return null;
      const raw = await redisClient.getdel(wsTicketKey(ticket));
      return parseOwner(raw);
    },
  };
}
