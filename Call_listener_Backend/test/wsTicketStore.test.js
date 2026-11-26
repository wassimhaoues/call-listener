import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createWsTicketStore,
  wsTicketKey,
  WS_TICKET_PREFIX,
  DEFAULT_WS_TICKET_TTL_SECONDS,
} from "../server/services/auth/wsTicketStore.js";
import { createMemoryRedis } from "./helpers/memoryRedis.js";

const OWNER = { app_id: "com.example.calllistener.test", device_id: "device-123456" };

function makeClock(start = 1_000_000) {
  let current = start;
  return { now: () => current, advance: (ms) => (current += ms) };
}

test("a ticket is 256 random bits as base64url, stored only by its SHA-256 hash", async () => {
  const redisClient = createMemoryRedis();
  const store = createWsTicketStore({ redisClient });
  const { ticket, expiresIn } = await store.issue(OWNER);

  assert.match(ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(ticket, "base64url").length, 32);
  assert.equal(expiresIn, DEFAULT_WS_TICKET_TTL_SECONDS);

  const key = `${WS_TICKET_PREFIX}${createHash("sha256").update(ticket).digest("hex")}`;
  assert.equal(wsTicketKey(ticket), key);
  assert.deepEqual([...redisClient.ttls.keys()], [key], "only the hashed key is written");
  assert.equal(redisClient.ttls.get(key), DEFAULT_WS_TICKET_TTL_SECONDS);
  assert.deepEqual(JSON.parse(await redisClient.get(key)), OWNER);
  assert.ok(!key.includes(ticket));
});

test("tickets are unique per issue", async () => {
  const store = createWsTicketStore({ redisClient: createMemoryRedis() });
  const tickets = new Set();
  for (let i = 0; i < 50; i += 1) tickets.add((await store.issue(OWNER)).ticket);
  assert.equal(tickets.size, 50);
});

test("a ticket is consumed once and returns exactly the issued owner", async () => {
  const store = createWsTicketStore({ redisClient: createMemoryRedis() });
  const { ticket } = await store.issue({ ...OWNER, extra: "ignored" });
  assert.deepEqual(await store.consume(ticket), OWNER);
  assert.equal(await store.consume(ticket), null, "a reused ticket is rejected");
});

test("concurrent consumption of one ticket succeeds at most once", async () => {
  const store = createWsTicketStore({ redisClient: createMemoryRedis() });
  const { ticket } = await store.issue(OWNER);
  const results = await Promise.all(Array.from({ length: 5 }, () => store.consume(ticket)));
  assert.equal(results.filter(Boolean).length, 1);
});

test("an expired ticket is rejected", async () => {
  const clock = makeClock();
  const store = createWsTicketStore({ redisClient: createMemoryRedis({ now: clock.now }), ttlSeconds: 5 });
  const { ticket, expiresIn } = await store.issue(OWNER);
  assert.equal(expiresIn, 5);
  clock.advance(5_000);
  assert.equal(await store.consume(ticket), null);
});

test("malformed or unknown tickets are rejected without a Redis lookup", async () => {
  const redisClient = createMemoryRedis();
  let lookups = 0;
  const getdel = redisClient.getdel;
  redisClient.getdel = (key) => {
    lookups += 1;
    return getdel(key);
  };
  const store = createWsTicketStore({ redisClient });
  for (const bad of [undefined, null, 42, "", "short", "x".repeat(44), `${"a".repeat(42)}=`, `${"a".repeat(42)}/`]) {
    assert.equal(await store.consume(bad), null);
  }
  assert.equal(lookups, 0);
  assert.equal(await store.consume("A".repeat(43)), null, "well-formed but unknown");
  assert.equal(lookups, 1);
});

test("a corrupted stored owner is rejected", async () => {
  const redisClient = createMemoryRedis();
  const store = createWsTicketStore({ redisClient });
  const ticket = "B".repeat(43);
  await redisClient.set(wsTicketKey(ticket), "not json", "EX", 30);
  assert.equal(await store.consume(ticket), null);
  await redisClient.set(wsTicketKey(ticket), JSON.stringify({ app_id: "x" }), "EX", 30);
  assert.equal(await store.consume(ticket), null);
});

test("Redis failures reject instead of authenticating", async () => {
  const down = Object.assign(new Error("down"), { code: "ECONNREFUSED" });
  const store = createWsTicketStore({
    redisClient: {
      set: async () => { throw down; },
      getdel: async () => { throw down; },
    },
  });
  await assert.rejects(store.issue(OWNER), /down/);
  await assert.rejects(store.consume("C".repeat(43)), /down/);
});

test("options and owners are validated", async () => {
  const redisClient = createMemoryRedis();
  assert.throws(() => createWsTicketStore(), /redisClient is required/);
  for (const ttlSeconds of [0, -1, 1.5, 301, Number.NaN]) {
    assert.throws(() => createWsTicketStore({ redisClient, ttlSeconds }), /ttlSeconds/);
  }
  const store = createWsTicketStore({ redisClient });
  await assert.rejects(store.issue({ app_id: OWNER.app_id }), /owner/);
  await assert.rejects(store.issue({ app_id: "", device_id: "d" }), /owner/);
  await assert.rejects(store.issue(), /owner/);
});
