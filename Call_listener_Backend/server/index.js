import { startWebSocketServer } from "./websocket/websocketServer.js";
import { handleConnection } from "./websocket/handlers/connectionHandler.js";
import { redis } from "./config/redis.js";
import { loggers } from "./core/logger/index.js";
import { CONFIG } from "./config/env.js";
import { createApp } from "./app.js";
import fs from "fs";
import path from "path";
const logsDir = path.join(process.cwd(), "logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const log = loggers.core;
const wss = startWebSocketServer({
  port: CONFIG.PORT,
  config: CONFIG,
  handleAuthenticatedConnection: handleConnection,
});
const app = createApp({ redisClient: redis, config: CONFIG });
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
