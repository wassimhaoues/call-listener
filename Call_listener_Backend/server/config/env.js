import dotenv from "dotenv";
import { parseModelAllowlist } from "./modelAllowlist.js";
import { resolveModelPrices } from "./modelPrices.js";
import { isWsTicketTtl } from "../services/auth/wsTicketStore.js";

dotenv.config({ quiet: true });

const AI_PROVIDER = process.env.AI_PROVIDER || "groq";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-5.6-luna";
const isDevelopment = process.env.NODE_ENV === "development";

/** Strict boolean env flag: unset uses the default; only "true"/"false" are accepted. */
function readBooleanFlag(name, defaultValue) {
  const value = process.env[name];
  if (value === undefined || value === "") return defaultValue;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}
const CONFIG = {
  DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
  REDIS_URL: process.env.REDIS_URL,
  PORT: Number(process.env.PORT || 4000),
  EXPRESS_PORT: Number(process.env.EXPRESS_PORT || 3000),
  APP_ID: process.env.APP_ID,
  JWT_SECRET: process.env.JWT_SECRET,
  JWT_TTL_SECONDS: Number(process.env.JWT_TTL_SECONDS),
  AI_PROVIDER,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  GROQ_MODEL: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  OPENROUTER_MODEL,
  OPENROUTER_ALLOWED_MODELS: parseModelAllowlist(
    process.env.OPENROUTER_ALLOWED_MODELS,
    OPENROUTER_MODEL
  ),
  OPENROUTER_CATALOG_TTL_MS: Number(process.env.OPENROUTER_CATALOG_TTL_MS || 10 * 60_000),
  OPENROUTER_MAX_OUTPUT_TOKENS: Number(process.env.OPENROUTER_MAX_OUTPUT_TOKENS || 600),
  OPENROUTER_REQUEST_TIMEOUT_MS: Number(process.env.OPENROUTER_REQUEST_TIMEOUT_MS || 10_000),
  // Safe retries of a failed provider attempt, inside the same request
  // deadline (see docs/plan/provider-retries.md).
  OPENROUTER_MAX_RETRIES: Number(process.env.OPENROUTER_MAX_RETRIES || 1),
  MAX_INTERVIEW_COST_USD: Number(process.env.MAX_INTERVIEW_COST_USD || 5),
  // Charged model calls (answers, actions, intro, debrief, retries that
  // reported usage) one interview may make, independent of their price.
  MAX_INTERVIEW_MODEL_CALLS: Number(process.env.MAX_INTERVIEW_MODEL_CALLS || 400),
  // How long a disconnected resume-capable session is kept for `{ resume }`.
  RESUME_WINDOW_MS: Number(process.env.RESUME_WINDOW_MS || 120_000),
  AUTH_RATE_LIMIT_PER_MINUTE: Number(process.env.AUTH_RATE_LIMIT_PER_MINUTE || 20),
  TRUST_PROXY_HOPS: Number(process.env.TRUST_PROXY_HOPS || 0),
  // Single-use WebSocket tickets (POST /ws-ticket).
  WS_TICKET_TTL_SECONDS: Number(process.env.WS_TICKET_TTL_SECONDS || 30),
  WS_TICKET_RATE_LIMIT_PER_MINUTE: Number(process.env.WS_TICKET_RATE_LIMIT_PER_MINUTE || 30),
  // Compatibility: also accept the JWT (cookie or ?token=) on the socket.
  WS_ALLOW_COOKIE_AUTH: readBooleanFlag("WS_ALLOW_COOKIE_AUTH", true),
  // Device deny-list: deny (true) or allow (false, default) when Redis is
  // unreachable, and how often open sockets are re-checked.
  REVOCATION_FAIL_CLOSED: readBooleanFlag("REVOCATION_FAIL_CLOSED", false),
  // When true, /auth/token refuses installations that present no enrolled
  // secret (older desktop builds). Turn on once every pilot client enrolls.
  ENROLLMENT_REQUIRED: readBooleanFlag("ENROLLMENT_REQUIRED", false),
  REVOCATION_SWEEP_MS: Number(process.env.REVOCATION_SWEEP_MS || 60_000),
  MAX_DISCONNECTED_SESSIONS_PER_OWNER: Number(process.env.MAX_DISCONNECTED_SESSIONS_PER_OWNER || 3),
  OPENROUTER_INPUT_USD_PER_MILLION_TOKENS: Number(process.env.OPENROUTER_INPUT_USD_PER_MILLION_TOKENS || 0.2),
  OPENROUTER_OUTPUT_USD_PER_MILLION_TOKENS: Number(process.env.OPENROUTER_OUTPUT_USD_PER_MILLION_TOKENS || 1.2),
  PREPARATION_DAILY_BUDGET_USD: Number(process.env.PREPARATION_DAILY_BUDGET_USD || 0.5),
  PREPARATION_MAX_OUTPUT_TOKENS: Number(process.env.PREPARATION_MAX_OUTPUT_TOKENS || 3_000),
  PREPARATION_REQUEST_TIMEOUT_MS: Number(process.env.PREPARATION_REQUEST_TIMEOUT_MS || 22_000),
  PREPARATION_RATE_LIMIT_PER_MINUTE: Number(process.env.PREPARATION_RATE_LIMIT_PER_MINUTE || 3),
  COOKIE_SECURE: process.env.COOKIE_SECURE
    ? process.env.COOKIE_SECURE === "true"
    : !isDevelopment,
  COOKIE_DOMAIN: process.env.COOKIE_DOMAIN || (isDevelopment ? undefined : "call.coworky.org"),
};

const required = [
  "DEEPGRAM_API_KEY",
  "REDIS_URL",
  "APP_ID",
  "JWT_SECRET",
  "JWT_TTL_SECONDS",
];
if (AI_PROVIDER === "groq") required.push("GROQ_API_KEY");
if (AI_PROVIDER === "openrouter") required.push("OPENROUTER_API_KEY");
if (!new Set(["groq", "openrouter"]).has(AI_PROVIDER)) {
  throw new Error("AI_PROVIDER must be groq or openrouter");
}
if (!isWsTicketTtl(CONFIG.WS_TICKET_TTL_SECONDS)) {
  throw new Error("WS_TICKET_TTL_SECONDS must be an integer between 1 and 300");
}
for (const key of ["AUTH_RATE_LIMIT_PER_MINUTE", "WS_TICKET_RATE_LIMIT_PER_MINUTE"]) {
  if (!Number.isInteger(CONFIG[key]) || CONFIG[key] < 1) {
    throw new Error(`${key} must be a positive integer`);
  }
}
if (
  !Number.isInteger(CONFIG.REVOCATION_SWEEP_MS) ||
  CONFIG.REVOCATION_SWEEP_MS < 1_000 ||
  CONFIG.REVOCATION_SWEEP_MS > 3_600_000
) {
  throw new Error("REVOCATION_SWEEP_MS must be an integer between 1000 and 3600000");
}
if (!Number.isInteger(CONFIG.TRUST_PROXY_HOPS) || CONFIG.TRUST_PROXY_HOPS < 0 || CONFIG.TRUST_PROXY_HOPS > 5) {
  throw new Error("TRUST_PROXY_HOPS must be an integer between 0 and 5");
}
if (!Number.isInteger(CONFIG.OPENROUTER_MAX_RETRIES) || CONFIG.OPENROUTER_MAX_RETRIES < 0 || CONFIG.OPENROUTER_MAX_RETRIES > 2) {
  throw new Error("OPENROUTER_MAX_RETRIES must be an integer between 0 and 2");
}
if (
  !Number.isInteger(CONFIG.MAX_DISCONNECTED_SESSIONS_PER_OWNER) ||
  CONFIG.MAX_DISCONNECTED_SESSIONS_PER_OWNER < 1
) {
  throw new Error("MAX_DISCONNECTED_SESSIONS_PER_OWNER must be a positive integer");
}
for (const key of [
  "OPENROUTER_MAX_OUTPUT_TOKENS",
  "OPENROUTER_REQUEST_TIMEOUT_MS",
  "OPENROUTER_CATALOG_TTL_MS",
  "MAX_INTERVIEW_COST_USD",
  "RESUME_WINDOW_MS",
  "OPENROUTER_INPUT_USD_PER_MILLION_TOKENS",
  "OPENROUTER_OUTPUT_USD_PER_MILLION_TOKENS",
  "PREPARATION_DAILY_BUDGET_USD",
]) {
  if (!Number.isFinite(CONFIG[key]) || CONFIG[key] < 0) {
    throw new Error(`${key} must be a non-negative number`);
  }
}

// Per-model billing prices. Every allowlisted model must be priced when
// OpenRouter is the provider; the default model may use the single-price pair.
CONFIG.OPENROUTER_MODEL_PRICES = resolveModelPrices({
  value: process.env.OPENROUTER_MODEL_PRICES,
  allowedModels: CONFIG.OPENROUTER_ALLOWED_MODELS,
  defaultModel: OPENROUTER_MODEL,
  defaultInputUsdPerMillionTokens: CONFIG.OPENROUTER_INPUT_USD_PER_MILLION_TOKENS,
  defaultOutputUsdPerMillionTokens: CONFIG.OPENROUTER_OUTPUT_USD_PER_MILLION_TOKENS,
  requireAll: AI_PROVIDER === "openrouter",
});

for (const key of [
  "PREPARATION_MAX_OUTPUT_TOKENS",
  "PREPARATION_REQUEST_TIMEOUT_MS",
  "PREPARATION_RATE_LIMIT_PER_MINUTE",
  "MAX_INTERVIEW_MODEL_CALLS",
]) {
  if (!Number.isInteger(CONFIG[key]) || CONFIG[key] < 1) {
    throw new Error(`${key} must be a positive integer`);
  }
}

for (const key of required) {
  if (!CONFIG[key]) {
    // eslint-disable-next-line no-console
    console.error(`Missing environment variable: ${key}`);
    throw new Error(`Missing environment variable: ${key}`);
  }
}

export { CONFIG };
