import { createHash } from "node:crypto";

/**
 * Fixed-window request limiter backed by Redis INCR/EXPIRE, so the limit holds
 * across instances. Keys use a hash of the client key (never a raw IP).
 *
 * Fails open: when Redis errors, the request is allowed and a warning is
 * logged, so a Redis outage cannot lock every candidate out of authentication.
 */
export function createFixedWindowLimiter({
  redisClient,
  prefix,
  limit,
  windowSeconds,
  keyFor = (req) => req.ip,
  log,
} = {}) {
  if (!redisClient) throw new TypeError("redisClient is required");
  if (typeof prefix !== "string" || !/^[a-z][a-z0-9:_-]{0,40}$/.test(prefix)) {
    throw new TypeError("prefix must be a short lowercase key prefix");
  }
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError("limit must be a positive integer");
  if (!Number.isInteger(windowSeconds) || windowSeconds < 1) {
    throw new TypeError("windowSeconds must be a positive integer");
  }

  const hashed = (value) => createHash("sha256").update(String(value ?? "unknown")).digest("hex").slice(0, 32);

  return async function rateLimit(req, res, next) {
    const key = `${prefix}:${hashed(keyFor(req))}`;
    let count;
    try {
      count = await redisClient.incr(key);
      if (count === 1) await redisClient.expire(key, windowSeconds);
    } catch (error) {
      log?.warn?.(`Rate limiter unavailable for ${prefix}; allowing request (${error?.code || "error"})`);
      return next();
    }
    if (count > limit) {
      res.set("Retry-After", String(windowSeconds));
      return res.status(429).json({ error: "rate_limited" });
    }
    return next();
  };
}
