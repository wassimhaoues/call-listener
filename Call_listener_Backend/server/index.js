import { startWebSocketServer } from "./websocket/websocketServer.js";
import { handleConnection } from "./websocket/handlers/connectionHandler.js";
import { redis } from "./config/redis.js";
import { loggers } from "./core/logger/index.js";
import { CONFIG } from "./config/env.js";
import { createApp } from "./app.js";
import { createModelCatalog } from "./services/ai/modelCatalog.js";
import { createConfiguredPricing } from "./services/ai/modelPricing.js";
import { createConfiguredPreparationBrief } from "./services/preparation/configuredPreparation.js";
import { createWsTicketStore } from "./services/auth/wsTicketStore.js";
import { createDeviceRevocation } from "./services/auth/deviceRevocation.js";
import fs from "fs";
import path from "path";
const logsDir = path.join(process.cwd(), "logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const log = loggers.core;
// One store for both servers: Express issues tickets, the socket consumes them.
const wsTickets = createWsTicketStore({ redisClient: redis, ttlSeconds: CONFIG.WS_TICKET_TTL_SECONDS });
// One operator deny-list for HTTP and the socket (scripts/admin/deviceRevocation.js).
const deviceRevocation = createDeviceRevocation({
  redisClient: redis,
  failClosed: CONFIG.REVOCATION_FAIL_CLOSED,
  log: loggers.core,
});
const wss = startWebSocketServer({
  port: CONFIG.PORT,
  config: CONFIG,
  handleAuthenticatedConnection: handleConnection,
  wsTickets,
  deviceRevocation,
  revocationSweepMs: CONFIG.REVOCATION_SWEEP_MS,
});
const modelPricing = createConfiguredPricing(CONFIG, loggers.ai);
const modelCatalog = createModelCatalog({
  provider: CONFIG.AI_PROVIDER,
  allowedModels: CONFIG.OPENROUTER_ALLOWED_MODELS,
  defaultModel: CONFIG.OPENROUTER_MODEL,
  ttlMs: CONFIG.OPENROUTER_CATALOG_TTL_MS,
  // Warn (never re-price) when a configured price is below OpenRouter's.
  onRefresh: (models) => modelPricing.warnIfBelowCatalog(models),
  log: loggers.ai,
});
const preparationBrief = createConfiguredPreparationBrief({
  config: CONFIG,
  redisClient: redis,
  log: loggers.ai,
});
const app = createApp({
  redisClient: redis,
  config: CONFIG,
  modelCatalog,
  preparationBrief,
  wsTickets,
  deviceRevocation,
  log: loggers.core,
});
app.listen(CONFIG.EXPRESS_PORT, () => {
  log.info(`🚀 Express server listening on port ${CONFIG.EXPRESS_PORT}`);
});

async function shutdown(signal) {
  try {
    log.info(`Received ${signal}. Shutting down...`);
    await new Promise((res) => wss.close(res));
    wss.clients.forEach((c) => {
      try { c.terminate(); } catch {}
    });
    await redis.quit();
  } catch (err) {
    log.error("Error while shutting down: %o", err);
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (e) => {
  log.error("Uncaught exception: %o", e);
  shutdown("uncaughtException");
});
process.on("unhandledRejection", (e) => {
  log.error("Unhandled rejection: %o", e);
  shutdown("unhandledRejection");
});

if (CONFIG.AI_PROVIDER === "openrouter") {
  // One catalog lookup once the servers are up, so an underpriced model is
  // reported at startup. getCatalog never rejects; a failed lookup is logged.
  await modelCatalog.getCatalog();
}
