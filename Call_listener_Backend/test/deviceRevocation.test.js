import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createDeviceRevocation,
  deviceFingerprint,
  normalizeReason,
  revocationKey,
  REASON_MAX_LENGTH,
} from "../server/services/auth/deviceRevocation.js";
import { closeRevokedClients } from "../server/websocket/websocketServer.js";
import { createMemoryRedis } from "./helpers/memoryRedis.js";

const DEVICE = "6f1c9a52-0d4b-4c43-9a57-2f7f1d1c0a01";
const FIXED_NOW = () => new Date("2026-11-26T10:00:00.000Z");

/** Memory Redis that records every key and value written. */
function recordingRedis() {
  const redis = createMemoryRedis();
  const writes = [];
  const set = redis.set.bind(redis);
  redis.set = (key, value, ...rest) => {
    writes.push({ key, value: String(value), rest });
    return set(key, value, ...rest);
  };
  return { redis, writes };
}

function failingRedis(code = "ECONNREFUSED") {
  const fail = async () => {
    const error = new Error("redis down");
    error.code = code;
    throw error;
  };
  return { get: fail, set: fail, del: fail };
}

function createLog() {
  const lines = [];
  return { lines, warn: (line) => lines.push(String(line)) };
}

test("revocation keys are revoked:<sha256 hex> and never contain the raw device ID", async () => {
  const { redis, writes } = recordingRedis();
  const revocation = createDeviceRevocation({ redisClient: redis, now: FIXED_NOW });
  const result = await revocation.revoke(DEVICE, { reason: "ticket 142" });

  const expectedHash = createHash("sha256").update(DEVICE).digest("hex");
  assert.equal(revocationKey(DEVICE), `revoked:${expectedHash}`);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].key, `revoked:${expectedHash}`);
  assert.deepEqual(writes[0].rest, [], "no expiry: a revocation lasts until restored");
  assert.ok(!writes[0].key.includes(DEVICE));
  assert.ok(!writes[0].value.includes(DEVICE));
  assert.deepEqual(JSON.parse(writes[0].value), { reason: "ticket 142", revoked_at: "2026-11-26T10:00:00.000Z" });
  assert.deepEqual(result, {
    fingerprint: expectedHash.slice(0, 12),
    reason: "ticket 142",
    revokedAt: "2026-11-26T10:00:00.000Z",
  });
  assert.equal(deviceFingerprint(DEVICE), expectedHash.slice(0, 12));
});

test("isRevoked, lookup and restore follow the stored record", async () => {
  const revocation = createDeviceRevocation({ redisClient: createMemoryRedis(), now: FIXED_NOW });
  assert.equal(await revocation.isRevoked(DEVICE), false);
  assert.deepEqual(await revocation.lookup(DEVICE), { revoked: false });

  await revocation.revoke(DEVICE);
  assert.equal(await revocation.isRevoked(DEVICE), true);
  assert.deepEqual(await revocation.lookup(DEVICE), {
    revoked: true,
    reason: "operator",
    revokedAt: "2026-11-26T10:00:00.000Z",
  });
  assert.deepEqual(await revocation.checkAccess(DEVICE), { allowed: false, error: "device_revoked" });
  assert.equal(await revocation.isRevoked("another-device-id"), false);

  assert.equal(await revocation.restore(DEVICE), true);
  assert.equal(await revocation.restore(DEVICE), false, "restoring twice is harmless");
  assert.equal(await revocation.isRevoked(DEVICE), false);
  assert.deepEqual(await revocation.checkAccess(DEVICE), { allowed: true });
});

test("a corrupted record still counts as revoked", async () => {
  const redis = createMemoryRedis();
  await redis.set(revocationKey(DEVICE), "not json");
  const revocation = createDeviceRevocation({ redisClient: redis });
  assert.deepEqual(await revocation.lookup(DEVICE), { revoked: true, reason: "operator", revokedAt: null });
});

test("reasons are bounded operator codes without free text", () => {
  assert.equal(normalizeReason(undefined), "operator");
  assert.equal(normalizeReason("   "), "operator");
  assert.equal(normalizeReason("  abuse   ticket #142 "), "abuse ticket #142");
  assert.equal(normalizeReason("x".repeat(REASON_MAX_LENGTH)).length, REASON_MAX_LENGTH);
  assert.throws(() => normalizeReason("x".repeat(REASON_MAX_LENGTH + 1)), /at most 120/);
  assert.throws(() => normalizeReason("jane.doe@example.com"), /may only use/, "no email addresses");
  assert.throws(() => normalizeReason("line\nbreak"), /may only use/);
  assert.throws(() => normalizeReason(42), /must be a string/);
});

test("revoke and restore validate the device ID", async () => {
  const revocation = createDeviceRevocation({ redisClient: createMemoryRedis() });
  for (const bad of [undefined, "", "short", 123, "x".repeat(257)]) {
    await assert.rejects(revocation.revoke(bad), /device id/);
    await assert.rejects(revocation.restore(bad), /device id/);
    await assert.rejects(revocation.isRevoked(bad), /device id/);
  }
  await assert.rejects(revocation.revoke(DEVICE, { reason: "a@b" }), /may only use/);
  assert.deepEqual(await revocation.checkAccess(undefined), { allowed: true }, "unauthenticated input is not a lookup");
});

test("the operator API rejects Redis failures instead of guessing", async () => {
  const revocation = createDeviceRevocation({ redisClient: failingRedis() });
  await assert.rejects(revocation.isRevoked(DEVICE), { code: "ECONNREFUSED" });
  await assert.rejects(revocation.revoke(DEVICE), { code: "ECONNREFUSED" });
  await assert.rejects(revocation.restore(DEVICE), { code: "ECONNREFUSED" });
});

test("checkAccess fails open by default and logs only the error code", async () => {
  const log = createLog();
  const revocation = createDeviceRevocation({ redisClient: failingRedis(), log });
  assert.equal(revocation.failClosed, false);
  assert.deepEqual(await revocation.checkAccess(DEVICE), { allowed: true });
  assert.equal(log.lines.length, 1);
  assert.match(log.lines[0], /ECONNREFUSED.*fail-open/);
  assert.ok(!log.lines[0].includes(DEVICE));
});

test("checkAccess fails closed when configured", async () => {
  const log = createLog();
  const revocation = createDeviceRevocation({ redisClient: failingRedis(), failClosed: true, log });
  assert.deepEqual(await revocation.checkAccess(DEVICE), { allowed: false, error: "revocation_unavailable" });
  assert.match(log.lines[0], /fail-closed/);
});

test("a hung Redis lookup times out and follows the failure mode", async () => {
  const hung = { get: () => new Promise(() => {}) };
  const open = createDeviceRevocation({ redisClient: hung, lookupTimeoutMs: 20 });
  assert.deepEqual(await open.checkAccess(DEVICE), { allowed: true });
  const closed = createDeviceRevocation({ redisClient: hung, lookupTimeoutMs: 20, failClosed: true });
  assert.deepEqual(await closed.checkAccess(DEVICE), { allowed: false, error: "revocation_unavailable" });
  await assert.rejects(open.isRevoked(DEVICE), { code: "ETIMEDOUT" });
});

test("createDeviceRevocation validates its options", () => {
  assert.throws(() => createDeviceRevocation(), /redisClient is required/);
  const redisClient = createMemoryRedis();
  assert.throws(() => createDeviceRevocation({ redisClient, failClosed: "true" }), /failClosed/);
  assert.throws(() => createDeviceRevocation({ redisClient, lookupTimeoutMs: 0 }), /lookupTimeoutMs/);
});

test("closeRevokedClients closes only open sockets of revoked installations, one lookup per device", async () => {
  const redis = createMemoryRedis();
  let lookups = 0;
  const get = redis.get.bind(redis);
  redis.get = (key) => {
    lookups += 1;
    return get(key);
  };
  const revocation = createDeviceRevocation({ redisClient: redis });
  await revocation.revoke(DEVICE);
  const OPEN = 1;
  const client = (deviceId, readyState = OPEN) => ({
    OPEN,
    readyState,
    user: deviceId ? { device_id: deviceId } : undefined,
    closed: null,
    close(code, reason) {
      this.closed = { code, reason };
    },
  });
  const clients = [client(DEVICE), client(DEVICE), client(DEVICE, 2), client("other-device-id"), client(null)];
  assert.equal(await closeRevokedClients(clients, revocation), 2);
  assert.equal(lookups, 2);
  assert.deepEqual(clients[0].closed, { code: 4003, reason: "device_revoked" });
  assert.deepEqual(clients[1].closed, { code: 4003, reason: "device_revoked" });
  assert.equal(clients[2].closed, null, "a closing socket is left alone");
  assert.equal(clients[3].closed, null);
  assert.equal(clients[4].closed, null);

  const unreachable = createDeviceRevocation({ redisClient: failingRedis() });
  const live = [client(DEVICE)];
  assert.equal(await closeRevokedClients(live, unreachable), 0);
  assert.equal(live[0].closed, null, "an unreachable deny-list never closes sockets");
});
