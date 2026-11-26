import express from "express";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";

/**
 * Create the HTTP API with explicit runtime dependencies.
 *
 * Keeping dependencies at this boundary makes the API testable without opening
 * a Redis connection or loading deployment credentials.
 */
export const PREPARATION_BODY_LIMIT = "256kb";

export function createApp({ redisClient, config, modelCatalog, preparationBrief } = {}) {
  if (!redisClient) throw new TypeError("redisClient is required");
  if (!config) throw new TypeError("config is required");

  const app = express();
  // Candidate contexts can exceed the 100 kB default; only this route gets more.
  app.use("/preparation", express.json({ limit: PREPARATION_BODY_LIMIT }));
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
  function verifyCookie(req) {
    const token = req.cookies?.call_token;
    if (!token) return { error: "no_cookie" };
    try {
      return {
        claims: jwt.verify(token, config.JWT_SECRET, {
          issuer: "call-backend",
          audience: "call-electron",
        }),
      };
    } catch {
      return { error: "invalid_cookie" };
    }
  }
  app.get("/auth/me", (req, res) => {
    const { claims, error } = verifyCookie(req);
    if (error) return res.status(401).json({ error });
    return res.json({ ok: true, claims });
  });
  app.get("/models", async (req, res) => {
    const { error } = verifyCookie(req);
    if (error) return res.status(401).json({ error });
    if (!modelCatalog) return res.status(503).json({ error: "model_catalog_unavailable" });
    try {
      res.set("Cache-Control", "private, max-age=60");
      return res.json(await modelCatalog.getCatalog());
    } catch {
      return res.status(503).json({ error: "model_catalog_unavailable" });
    }
  });
  app.post("/preparation/brief", async (req, res) => {
    const { claims, error } = verifyCookie(req);
    if (error) return res.status(401).json({ error });
    if (!preparationBrief) return res.status(501).json({ error: "preparation_unavailable" });
    // Stop paying for a brief nobody is waiting for.
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort(new Error("client_closed"));
    });
    try {
      const result = await preparationBrief.generate(req.body, {
        deviceId: claims.device_id,
        signal: controller.signal,
      });
      res.set("Cache-Control", "no-store");
      return res.json(result);
    } catch (error_) {
      // Only typed preparation failures expose their code; anything else is a 502.
      const typed = Number.isInteger(error_?.status) && typeof error_?.code === "string";
      if (typed) return res.status(error_.status).json({ error: error_.code });
      return res.status(502).json({ error: "preparation_failed" });
    }
  });
  // Malformed or oversized JSON bodies get a stable JSON error, not HTML.
  app.use((err, _req, res, next) => {
    if (err?.type === "entity.too.large") return res.status(413).json({ error: "payload_too_large" });
    if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "invalid_json" });
    return next(err);
  });
  return app;
}
