import { readFileSync } from "node:fs";

const FIXTURE_ROOT = new URL("../fixtures/", import.meta.url);

/**
 * Expected budget charge for a provider call whose response omits usage:
 * ceil(chars / 4) tokens for system prompt + history and for the trimmed reply,
 * priced at the harness rates (defaults match `createReplayHarness`).
 */
export function estimatedCostUsd(call, response, {
  inputUsdPerMillionTokens = 0.2,
  outputUsdPerMillionTokens = 1.2,
} = {}) {
  const inputTokens = Math.ceil((String(call.system).length + String(call.history).length) / 4);
  // Streamed fixtures carry their text as `chunks` instead of `content`.
  const content = response.content ?? (response.chunks || []).join("");
  const outputTokens = Math.ceil(String(content).trim().length / 4);
  return (inputTokens * inputUsdPerMillionTokens + outputTokens * outputUsdPerMillionTokens) / 1_000_000;
}

/**
 * Expand compact generator directives so large or binary-ish payloads stay
 * readable in JSON:
 * - `{ "$repeat": "a", "times": 3 }` -> `"aaa"`
 * - `{ "$array": "Skill", "times": 2 }` -> `["Skill 1", "Skill 2"]`
 * - `{ "$arrayOf": { ... }, "times": 2 }` -> two copies of the object
 * - `{ "$base64Zeros": 4 }` -> base64 of four zero bytes (PCM16 silence)
 */
export function materialize(value) {
  if (Array.isArray(value)) return value.map(materialize);
  if (!value || typeof value !== "object") return value;
  if (typeof value.$repeat === "string") return value.$repeat.repeat(value.times);
  if (typeof value.$array === "string") {
    return Array.from({ length: value.times }, (_, index) => `${value.$array} ${index + 1}`);
  }
  if (value.$arrayOf !== undefined) {
    return Array.from({ length: value.times }, () => materialize(structuredClone(value.$arrayOf)));
  }
  if (Number.isInteger(value.$base64Zeros)) {
    return Buffer.alloc(value.$base64Zeros).toString("base64");
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, materialize(item)])
  );
}

export function loadFixture(relativePath) {
  return materialize(JSON.parse(readFileSync(new URL(relativePath, FIXTURE_ROOT), "utf8")));
}

function setPath(target, path, value) {
  const keys = path.split(".");
  let cursor = target;
  for (const key of keys.slice(0, -1)) cursor = cursor[key];
  cursor[keys.at(-1)] = value;
}

/** Resolve a context case: either a literal `payload` or `base` + `set` overrides. */
export function resolveContextCase(contexts, testCase) {
  if ("payload" in testCase) return structuredClone(testCase.payload);
  const payload = structuredClone(contexts.valid[testCase.base].payload);
  for (const [path, value] of Object.entries(testCase.set || {})) setPath(payload, path, value);
  return payload;
}

export function loadContexts() {
  return loadFixture("contexts.json");
}

export function loadProviderResponses() {
  return loadFixture("providerResponses.json");
}

/** A silent 16-bit PCM chunk of `bytes` bytes, base64-encoded like the desktop client. */
export function silentPcmChunk(bytes) {
  return Buffer.alloc(bytes).toString("base64");
}
