import Redis from "ioredis";
import { CONFIG } from "./env.js";
import { loggers } from "../core/logger/index.js";

const log = loggers.redis;

export const redis = new Redis(CONFIG.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

redis.on("connect", () => log.info("Redis connecting..."));
redis.on("ready", () => log.info("Redis ready"));
redis.on("reconnecting", (ms) => log.warn(`Redis reconnecting in ${ms}ms`));
redis.on("error", (err) => log.error("Redis error: %o", err));
redis.on("end", () => log.warn("Redis connection ended"));
