import test from "node:test";
import assert from "node:assert/strict";
import { createChatHistory } from "../server/services/chat/chatHistory.js";
import { createContextStore } from "../server/services/chat/contextStore.js";

function createRedisFake() {
  const calls = [];
  return {
    calls,
    async rpush(...args) { calls.push(["rpush", ...args]); },
    async ltrim(...args) { calls.push(["ltrim", ...args]); },
    async expire(...args) { calls.push(["expire", ...args]); },
    async set(...args) { calls.push(["set", ...args]); },
    async del(...args) { calls.push(["del", ...args]); },
    async lrange() { return []; },
    async get() { return null; },
  };
}

const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

test("chat history bounds entries and refreshes an expiry on every turn", async () => {
  const redisClient = createRedisFake();
  const history = createChatHistory({
    redisClient,
    maxEntries: 3,
    ttlSeconds: 90,
    log: silentLog,
  });

  await history.push("session-1", "candidate", "I led the migration.");

  assert.equal(redisClient.calls[0][0], "rpush");
  assert.equal(redisClient.calls[0][1], "chat:session-1");
  assert.deepEqual(JSON.parse(redisClient.calls[0][2]), {
    role: "candidate",
    text: "I led the migration.",
    ts: JSON.parse(redisClient.calls[0][2]).ts,
  });
  assert.deepEqual(redisClient.calls.slice(1), [
    ["ltrim", "chat:session-1", -3, -1],
    ["expire", "chat:session-1", 90],
  ]);
});

test("context storage uses an expiry and malformed chat records cannot poison prompts", async () => {
  const redisClient = createRedisFake();
  redisClient.lrange = async () => ["not-json", JSON.stringify({ role: "interviewer", text: "Question" })];
  const context = createContextStore({ redisClient, ttlSeconds: 120, log: silentLog });
  const history = createChatHistory({ redisClient, log: silentLog });

  await context.set("session-1", { jobOffer: "Platform engineer" });
  const prompt = await history.toPrompt("session-1");

  assert.deepEqual(redisClient.calls[0], [
    "set",
    "context:session-1",
    JSON.stringify({ jobOffer: "Platform engineer" }),
    "EX",
    120,
  ]);
  assert.equal(prompt, "interviewer: Question");
});

test("session stores require Redis and valid retention limits", () => {
  assert.throws(() => createChatHistory(), /redisClient is required/);
  assert.throws(
    () => createChatHistory({ redisClient: {}, maxEntries: 0 }),
    /maxEntries must be a positive integer/
  );
  assert.throws(() => createContextStore(), /redisClient is required/);
  assert.throws(
    () => createContextStore({ redisClient: {}, ttlSeconds: 0 }),
    /ttlSeconds must be a positive integer/
  );
});
