// server/websocket/websocketServer.js
import { WebSocketServer } from "ws";
import { loggers } from "../core/logger/index.js";
import jwt from "jsonwebtoken";

const log = loggers.websocket;
const HEARTBEAT_MS = 30_000;
const MAX_WS_MESSAGE_BYTES = 128 * 1024;
export const REVOKED_CLOSE_CODE = 4003;
export const DEFAULT_REVOCATION_SWEEP_MS = 60_000;

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

function readQuery(req) {
  try {
    return new URL(req.url, "http://localhost").searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function getTokenFromReq(req, query) {
  // 1) querystring (legacy clients)
  const token = query.get("token");
  if (token) return token;

  // 2) cookie
  try {
    const cookies = parseCookies(req.headers["cookie"]);
    return cookies.call_token || null;
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

const rejected = (code, reason) => ({ rejected: { code, reason } });

async function authenticateWithTicket(ticket, { config, wsTickets }) {
  if (!wsTickets) return rejected(4001, "auth_failed");
  let owner;
  try {
    owner = await wsTickets.consume(ticket);
  } catch (e) {
    log.warn(`WS ticket check unavailable (${e?.code || "error"})`);
    return rejected(1011, "auth_unavailable");
  }
  if (!owner) {
    log.warn("WS auth failed: unknown, expired, or reused ticket");
    return rejected(4001, "auth_failed");
  }
  if (owner.app_id !== config.APP_ID) {
    log.warn("WS auth failed: ticket for another app");
    return rejected(4001, "auth_failed");
  }
  return { user: { device_id: owner.device_id, app_id: owner.app_id } };
}

function authenticateWithToken(req, query, config) {
  const token = getTokenFromReq(req, query);
  if (!token) return rejected(4001, "auth_required");
  try {
    const claims = verifyToken(token, config);
    return { user: { device_id: claims.device_id, app_id: claims.app_id } };
  } catch (e) {
    log.warn("WS auth failed: %o", e.message || e);
    return rejected(4001, "auth_failed");
  }
}

/**
 * Resolve the connection owner. A `?ticket=` is authoritative: when present,
 * the cookie and `?token=` are ignored, so a bad ticket never falls back to
 * the long-lived JWT. Without a ticket, the JWT path is used only while
 * `WS_ALLOW_COOKIE_AUTH` is not false.
 */
function resolveOwner(req, { config, wsTickets }) {
  const query = readQuery(req);
  const ticket = query.get("ticket");
  if (ticket !== null) return authenticateWithTicket(ticket, { config, wsTickets });
  if (config.WS_ALLOW_COOKIE_AUTH === false) return rejected(4001, "auth_required");
  return authenticateWithToken(req, query, config);
}

/**
 * Authenticate the handshake, then refuse installations on the operator
 * deny-list (`4003 device_revoked`) whichever credential was used. When the
 * deny-list is unreachable and `deviceRevocation.failClosed` is set, the
 * connection closes with `1011 auth_unavailable`; otherwise it is allowed.
 */
export async function authenticateUpgrade(req, { config, wsTickets, deviceRevocation }) {
  const result = await resolveOwner(req, { config, wsTickets });
  if (!result.user || !deviceRevocation) return result;
  const access = await deviceRevocation.checkAccess(result.user.device_id);
  if (access.allowed) return result;
  if (access.error === "device_revoked") {
    log.warn("WS auth refused: revoked installation");
    return rejected(REVOKED_CLOSE_CODE, "device_revoked");
  }
  return rejected(1011, "auth_unavailable");
}

/**
 * Close every open socket whose installation is now revoked. Only a definite
 * revocation closes a socket: an unreachable deny-list never does, in either
 * failure mode, so a Redis outage does not disconnect live interviews.
 */
export async function closeRevokedClients(clients, deviceRevocation) {
  const byDevice = new Map();
  for (const client of clients) {
    const deviceId = client.user?.device_id;
    if (!deviceId || client.readyState !== client.OPEN) continue;
    if (!byDevice.has(deviceId)) byDevice.set(deviceId, []);
    byDevice.get(deviceId).push(client);
  }
  let unavailable = 0;
  const checks = [...byDevice.keys()].map((deviceId) =>
    deviceRevocation.isRevoked(deviceId).catch(() => {
      unavailable += 1;
      return false;
    })
  );
  const revoked = await Promise.all(checks);
  let closed = 0;
  [...byDevice.values()].forEach((owned, index) => {
    if (!revoked[index]) return;
    for (const client of owned) {
      client.close(REVOKED_CLOSE_CODE, "device_revoked");
      closed += 1;
    }
  });
  if (unavailable > 0) log.warn(`Revocation sweep skipped ${unavailable} installation(s): deny-list unavailable`);
  if (closed > 0) log.warn(`Revocation sweep closed ${closed} socket(s) of revoked installations`);
  return closed;
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
  wsTickets,
  deviceRevocation,
  revocationSweepMs = DEFAULT_REVOCATION_SWEEP_MS,
} = {}) {
  if (!config) throw new TypeError("config is required");
  if (typeof handleAuthenticatedConnection !== "function") {
    throw new TypeError("handleAuthenticatedConnection is required");
  }

  // Authentication runs during the handshake (ticket consumption is async), so
  // no frame can arrive before the connection handler attaches its listeners.
  // The handshake itself always completes; a rejected connection is then
  // closed with its documented code and reason.
  const verifyClient = (info, done) => {
    const accept = (result) => {
      info.req.callAuth = result;
      done(true);
    };
    authenticateUpgrade(info.req, { config, wsTickets, deviceRevocation }).then(accept, () => accept(rejected(4001, "auth_failed")));
  };
  const wss = new WebSocketServer({ port, maxPayload: MAX_WS_MESSAGE_BYTES, verifyClient });
  log.info(`🚀 WebSocket server listening on port ${port}`);

  wss.on("connection", (wsClient, req) => {
    const auth = req.callAuth;
    delete req.callAuth;
    if (!auth?.user) {
      const { code, reason } = auth?.rejected ?? { code: 4001, reason: "auth_failed" };
      wsClient.close(code, reason);
      return;
    }
    wsClient.user = auth.user;

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

  // Already-open sockets of a revoked installation are closed within one sweep
  // interval. Every instance reads the shared Redis deny-list, so this also
  // covers multi-instance deployments.
  let sweep = null;
  if (deviceRevocation && revocationSweepMs > 0) {
    let sweeping = false;
    sweep = setInterval(() => {
      if (sweeping) return;
      sweeping = true;
      closeRevokedClients(wss.clients, deviceRevocation)
        .catch((err) => log.error("Revocation sweep failed: %o", err?.code || "error"))
        .finally(() => {
          sweeping = false;
        });
    }, revocationSweepMs);
  }

  wss.on("close", () => {
    clearInterval(interval);
    if (sweep) clearInterval(sweep);
  });
  wss.on("error", (err) => log.error("WS server error: %o", err));
  return wss;
}
