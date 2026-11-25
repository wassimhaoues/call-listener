/**
 * In-memory subset of the ioredis API used by the session stores and the
 * interview budget. Enough to run the real adapters without a Redis server.
 */
export function createMemoryRedis() {
  const strings = new Map();
  const lists = new Map();
  const hashes = new Map();
  const ttls = new Map();

  function normalizeIndex(index, length) {
    return index < 0 ? Math.max(0, length + index) : index;
  }

  return {
    ttls,
    async get(key) {
      return strings.has(key) ? strings.get(key) : null;
    },
    async set(key, value, mode, seconds) {
      strings.set(key, String(value));
      if (mode === "EX") ttls.set(key, seconds);
      return "OK";
    },
    async del(key) {
      const existed = strings.delete(key) || lists.delete(key) || hashes.delete(key);
      ttls.delete(key);
      return existed ? 1 : 0;
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
    async hgetall(key) {
      return { ...(hashes.get(key) || {}) };
    },
  };
}
