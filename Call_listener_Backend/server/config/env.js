import dotenv from "dotenv";
import { parseModelAllowlist } from "./modelAllowlist.js";

dotenv.config({ quiet: true });

const AI_PROVIDER = process.env.AI_PROVIDER || "groq";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-5.6-luna";
const isDevelopment = process.env.NODE_ENV === "development";
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
  MAX_INTERVIEW_COST_USD: Number(process.env.MAX_INTERVIEW_COST_USD || 5),
  OPENROUTER_INPUT_USD_PER_MILLION_TOKENS: Number(process.env.OPENROUTER_INPUT_USD_PER_MILLION_TOKENS || 0.2),
  OPENROUTER_OUTPUT_USD_PER_MILLION_TOKENS: Number(process.env.OPENROUTER_OUTPUT_USD_PER_MILLION_TOKENS || 1.2),
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
for (const key of [
  "OPENROUTER_MAX_OUTPUT_TOKENS",
  "OPENROUTER_REQUEST_TIMEOUT_MS",
  "OPENROUTER_CATALOG_TTL_MS",
  "MAX_INTERVIEW_COST_USD",
  "OPENROUTER_INPUT_USD_PER_MILLION_TOKENS",
  "OPENROUTER_OUTPUT_USD_PER_MILLION_TOKENS",
]) {
  if (!Number.isFinite(CONFIG[key]) || CONFIG[key] < 0) {
    throw new Error(`${key} must be a non-negative number`);
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
