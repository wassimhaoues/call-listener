// server/websocket/websocketServer.js
import { WebSocketServer } from "ws";
import { loggers } from "../core/logger/index.js";
import jwt from "jsonwebtoken";

const log = loggers.websocket;
const HEARTBEAT_MS = 30_000;
const MAX_WS_MESSAGE_BYTES = 128 * 1024;

function heartbeat() {
  this.isAlive = true;
}
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx > -1) {
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      out[k] = decodeURIComponent(v);
    }
  });
  return out;
}

function getTokenFromReq(req) {
  try {
    // 1) querystring
    const url = new URL(req.url, "http://localhost");
    const token = url.searchParams.get("token");
    if (token) return token;

    // 2) cookie
    const cookies = parseCookies(req.headers["cookie"]);
    if (cookies.call_token) return cookies.call_token;

    return null;
  } catch {
    return null;
  }
}
function verifyToken(token, config) {
  const payload = jwt.verify(token, config.JWT_SECRET, {
    issuer: "call-backend",
    audience: "call-electron",
  });
  if (payload.app_id !== config.APP_ID) {
    throw new Error("bad app_id");
  }
  if (!payload.device_id) {
    throw new Error("missing device_id");
  }
  return payload;
}

/**
 * Start the authenticated WebSocket boundary with explicit runtime dependencies.
 *
 * This lets protocol tests exercise authentication without importing Redis,
 * transcription, or deployment environment configuration.
 */
export function startWebSocketServer({
  port = 4000,
  config,
  handleAuthenticatedConnection,
} = {}) {
  if (!config) throw new TypeError("config is required");
  if (typeof handleAuthenticatedConnection !== "function") {
    throw new TypeError("handleAuthenticatedConnection is required");
  }

  const wss = new WebSocketServer({ port, maxPayload: MAX_WS_MESSAGE_BYTES });
  log.info(`🚀 WebSocket server listening on port ${port}`);

  wss.on("connection", (wsClient, req) => {
    // 🔒 AUTH
    try {
      const token = getTokenFromReq(req);
      if (!token) {
        wsClient.close(4001, "auth_required");
        return;
      }
      const claims = verifyToken(token, config);
      wsClient.user = { device_id: claims.device_id, app_id: claims.app_id };
    } catch (e) {
      log.warn("WS auth failed: %o", e.message || e);
      wsClient.close(4001, "auth_failed");
      return;
    }

    wsClient.isAlive = true;
    wsClient.on("pong", heartbeat);
    handleAuthenticatedConnection(wsClient, req, wss);
  });

  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        try {
          ws.terminate();
        } catch {}
        return;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {}
    });
  }, HEARTBEAT_MS);

  wss.on("close", () => clearInterval(interval));
  wss.on("error", (err) => log.error("WS server error: %o", err));
  return wss;
}
