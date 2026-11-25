import express from "express";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";

/**
 * Create the HTTP API with explicit runtime dependencies.
 *
 * Keeping dependencies at this boundary makes the API testable without opening
 * a Redis connection or loading deployment credentials.
 */
export function createApp({ redisClient, config } = {}) {
  if (!redisClient) throw new TypeError("redisClient is required");
  if (!config) throw new TypeError("config is required");

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.get("/health", async (_req, res) => {
    const redisStatus = redisClient.status;
    res.json({ status: "ok", redis: redisStatus });
  });
  app.get("/ready", async (_req, res) => {
    const redisStatus = redisClient.status;
    const ready = redisStatus === "ready";
    res.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "not_ready",
      redis: redisStatus,
    });
  });
  app.post("/auth/token", (req, res) => {
    try {
      const { app_id, device_id } = req.body || {};
      if (app_id !== config.APP_ID) {
        return res.status(401).json({ error: "invalid app" });
      }
      if (!device_id || typeof device_id !== "string" || device_id.length < 6) {
        return res.status(400).json({ error: "invalid device_id" });
      }

      const now = Math.floor(Date.now() / 1000);
      const payload = {
        app_id,
        device_id,
        iat: now,
      };
      const token = jwt.sign(payload, config.JWT_SECRET, {
        expiresIn: config.JWT_TTL_SECONDS,
        issuer: "call-backend",
        audience: "call-electron",
      });

      const cookieOptions = {
        httpOnly: true,
        secure: config.COOKIE_SECURE ?? true,
        sameSite: (config.COOKIE_SECURE ?? true) ? "none" : "lax",
        maxAge: config.JWT_TTL_SECONDS * 1000,
        path: "/",
      };
      if (config.COOKIE_DOMAIN) cookieOptions.domain = config.COOKIE_DOMAIN;
      res.cookie?.("call_token", token, cookieOptions);

      res.json({ token, expires_in: config.JWT_TTL_SECONDS });
    } catch (e) {
      return res.status(500).json({ error: "token_issue_failed" });
    }
  });
  app.get("/auth/me", (req, res) => {
    const token = req.cookies?.call_token;
    if (!token) return res.status(401).json({ error: "no_cookie" });
    try {
      const claims = jwt.verify(token, config.JWT_SECRET, {
        issuer: "call-backend",
        audience: "call-electron",
      });
      return res.json({ ok: true, claims });
    } catch {
      return res.status(401).json({ error: "invalid_cookie" });
    }
  });
  return app;
}
