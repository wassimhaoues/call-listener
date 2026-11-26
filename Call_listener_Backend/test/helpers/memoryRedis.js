/**
 * In-memory subset of the ioredis API used by the session stores, the
 * interview and preparation budgets, and WebSocket tickets. Enough to run the
 * real adapters without a Redis server.
 *
 * `SET ... EX` records a deadline on the injectable clock `now()` (ms); GET and
 * GETDEL treat a string past its deadline as missing, like Redis expiry.
 */
export function createMemoryRedis({ now = () => Date.now() } = {}) {
  const strings = new Map();
  const lists = new Map();
  const hashes = new Map();
  const ttls = new Map();
  const deadlines = new Map();

  function dropIfExpired(key) {
    if (deadlines.has(key) && now() >= deadlines.get(key)) {
      strings.delete(key);
      deadlines.delete(key);
      ttls.delete(key);
    }
  }

  function normalizeIndex(index, length) {
    return index < 0 ? Math.max(0, length + index) : index;
  }

  return {
    ttls,
    async get(key) {
      dropIfExpired(key);
      return strings.has(key) ? strings.get(key) : null;
    },
    async getdel(key) {
      dropIfExpired(key);
      if (!strings.has(key)) return null;
      const value = strings.get(key);
      strings.delete(key);
      ttls.delete(key);
      deadlines.delete(key);
      return value;
    },
    async set(key, value, mode, seconds) {
      // `SET key value NX`: only when the key does not exist (null otherwise).
      if (mode === "NX") {
        dropIfExpired(key);
        if (strings.has(key)) return null;
        strings.set(key, String(value));
        return "OK";
      }
      strings.set(key, String(value));
      deadlines.delete(key);
      if (mode === "EX") {
        ttls.set(key, seconds);
        deadlines.set(key, now() + seconds * 1000);
      }
      return "OK";
    },
    async del(key) {
      const existed = strings.delete(key) || lists.delete(key) || hashes.delete(key);
      ttls.delete(key);
      return existed ? 1 : 0;
    },
    async incr(key) {
      const next = Number(strings.get(key) || 0) + 1;
      strings.set(key, String(next));
      return next;
    },
    async incrbyfloat(key, amount) {
      const next = Number(strings.get(key) || 0) + Number(amount);
      strings.set(key, String(next));
      return String(next);
    },
    async ttl(key) {
      if (!strings.has(key) && !lists.has(key) && !hashes.has(key)) return -2;
      return ttls.has(key) ? ttls.get(key) : -1;
    },
    async expire(key, seconds) {
      ttls.set(key, seconds);
      return 1;
    },
    async rpush(key, ...values) {
      const list = lists.get(key) || [];
      list.push(...values.map(String));
      lists.set(key, list);
      return list.length;
    },
    async ltrim(key, start, stop) {
      const list = lists.get(key) || [];
      const from = normalizeIndex(start, list.length);
      const to = normalizeIndex(stop, list.length);
      lists.set(key, list.slice(from, to + 1));
      return "OK";
    },
    async lrange(key, start, stop) {
      const list = lists.get(key) || [];
      const from = normalizeIndex(start, list.length);
      const to = normalizeIndex(stop, list.length);
      return list.slice(from, to + 1);
    },
    async hget(key, field) {
      return hashes.get(key)?.[field] ?? null;
    },
    async hset(key, fields) {
      hashes.set(key, { ...(hashes.get(key) || {}), ...fields });
      return Object.keys(fields).length;
    },
    async hincrbyfloat(key, field, delta) {
      const hash = { ...(hashes.get(key) || {}) };
      hash[field] = String(Number(hash[field] || 0) + Number(delta));
      hashes.set(key, hash);
      return hash[field];
    },
    async hincrby(key, field, delta) {
      const hash = { ...(hashes.get(key) || {}) };
      hash[field] = String(Number.parseInt(hash[field] || "0", 10) + Number.parseInt(delta, 10));
      hashes.set(key, hash);
      return Number(hash[field]);
    },
    async hgetall(key) {
      return { ...(hashes.get(key) || {}) };
    },
  };
}
