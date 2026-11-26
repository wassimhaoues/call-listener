// services/auth.js

// Wall-clock bound for the startup token request. Without it a backend that
// accepts the TCP/TLS connection but never answers leaves the auth gate (and
// the window) waiting forever.
const AUTH_REQUEST_TIMEOUT_MS = 10_000;

/** Timeout error classified as server_unreachable by services/authFailure.js. */
function makeTimeoutError(label, timeoutMs) {
  return Object.assign(new Error(`${label} request timed out after ${timeoutMs} ms`), {
    code: "ETIMEDOUT",
  });
}

/**
 * Settle a request promise at most once, and reject (destroying the request)
 * if it has not settled within timeoutMs.
 */
function withDeadline(req, resolve, reject, { label, timeoutMs }) {
  let settled = false;
  const timer = setTimeout(() => {
    const err = makeTimeoutError(label, timeoutMs);
    finish(reject, err);
    try {
      req.destroy?.(err);
    } catch {}
  }, timeoutMs);
  const finish = (fn, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    fn(value);
  };
  return {
    resolve: (value) => finish(resolve, value),
    reject: (err) => finish(reject, err),
  };
}

class AuthManager {
  /**
   * @param {{ requestClient:any, appId:string, backendHost:string, electronSession: Electron.Session, requestTimeoutMs?:number }} opts
   */
  constructor(opts) {
    this.requestClient = opts.requestClient;
    this.backendHost = opts.backendHost;
    this.backendProtocol = opts.backendProtocol || "https";
    this.backendPort = opts.backendPort || (this.backendProtocol === "https" ? 443 : 80);
    this.wsProtocol = opts.wsProtocol || "wss";
    this.wsPort = opts.wsPort || (this.wsProtocol === "wss" ? 443 : 80);
    this.appId = opts.appId;
    this.session = opts.electronSession;
    this.deviceId = opts.deviceId;
    if (!this.deviceId || typeof this.deviceId !== "string") {
      throw new TypeError("deviceId is required");
    }

    this.requestTimeoutMs = opts.requestTimeoutMs || AUTH_REQUEST_TIMEOUT_MS;

    this.token = null;
    this.refreshTimer = null;
  }

  _postToken(deviceId) {
    const payload = JSON.stringify({ app_id: this.appId, device_id: deviceId });
    return new Promise((outerResolve, outerReject) => {
      let resolve = outerResolve;
      let reject = outerReject;
      const req = this.requestClient.request(
        {
          hostname: this.backendHost,
          port: this.backendPort,
          path: "/auth/token",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
        },
        (res) => {
          let buf = "";
          res.on("data", (d) => (buf += d));
          res.on("end", () => {
            if (res.statusCode !== 200) {
              return reject(
                Object.assign(new Error(`Token HTTP ${res.statusCode}: ${buf}`), {
                  statusCode: res.statusCode,
                })
              );
            }
            try {
              const json = JSON.parse(buf); // { token, expires_in }
              resolve(json);
            } catch (e) {
              reject(e);
            }
          });
        }
      );
      ({ resolve, reject } = withDeadline(req, outerResolve, outerReject, {
        label: "Token",
        timeoutMs: this.requestTimeoutMs,
      }));
      req.on("error", (e) => reject(e));
      req.write(payload);
      req.end();
    });
  }

  _scheduleRefresh(expiresInSec) {
    const baseMs = Math.max(60_000, ((expiresInSec ?? 3600) - 120) * 1000);
    const jitter = 0.95 + Math.random() * 0.1;
    const delay = Math.floor(baseMs * jitter);
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(async () => {
      this.token = null;
      try {
        await this.ensure(true);
      } catch (e) {
        console.error("[auth] refresh failed; retrying soon:", e);
        const retry = 20_000 + Math.floor(Math.random() * 10_000);
        setTimeout(() => this.ensure(true).catch(() => {}), retry);
      }
    }, delay);
  }

  async ensure(force = false) {
    if (this.token && !force) return this.token;
    const { token, expires_in } = await this._postToken(this.deviceId);
    this.token = token;

    // Store cookie so Chromium WSS handshakes include it as needed
    await this.session.cookies.set({
      url: this._baseUrl(this.backendProtocol, this.backendPort),
      name: "call_token",
      value: token,
      httpOnly: true,
      secure: this.backendProtocol === "https",
      sameSite: this.backendProtocol === "https" ? "no_restriction" : "lax",
      path: "/",
    });

    this._scheduleRefresh(expires_in);
    console.log("[auth] token obtained");
    return this.token;
  }

  async getCachedTokenOrFetch() {
    if (this.token) return this.token;
    return this.ensure();
  }

  /**
   * Return the WebSocket endpoint without exposing the bearer token to the
   * renderer or URL logs. Chromium supplies the secure call_token cookie.
   */
  async makeSignedWsUrl() {
    await this.getCachedTokenOrFetch();
    return `${this._baseUrl(this.wsProtocol, this.wsPort)}/ws`;
  }

  /**
   * Fetch the backend's allowlisted model catalog with the main-process token.
   * Returns only catalog fields so nothing auth-related reaches the renderer.
   */
  async fetchModels({ timeoutMs = 5_000 } = {}) {
    const token = await this.getCachedTokenOrFetch();
    const body = await new Promise((outerResolve, outerReject) => {
      let resolve = outerResolve;
      let reject = outerReject;
      const req = this.requestClient.request(
        {
          hostname: this.backendHost,
          port: this.backendPort,
          path: "/models",
          method: "GET",
          headers: { Accept: "application/json", Cookie: `call_token=${token}` },
          timeout: timeoutMs,
        },
        (res) => {
          let buf = "";
          res.on("data", (d) => (buf += d));
          res.on("end", () => {
            if (res.statusCode !== 200) {
              return reject(new Error(`Models HTTP ${res.statusCode}`));
            }
            try {
              resolve(JSON.parse(buf));
            } catch (e) {
              reject(e);
            }
          });
        }
      );
      ({ resolve, reject } = withDeadline(req, outerResolve, outerReject, {
        label: "Models",
        timeoutMs,
      }));
      req.on("timeout", () => req.destroy(makeTimeoutError("Models", timeoutMs)));
      req.on("error", (e) => reject(e));
      req.end();
    });
    return sanitizeCatalog(body);
  }

  _baseUrl(protocol, port) {
    const defaultPort = protocol === "https" || protocol === "wss" ? 443 : 80;
    const portSuffix = port === defaultPort ? "" : `:${port}`;
    return `${protocol}://${this.backendHost}${portSuffix}`;
  }
}

const AVAILABILITY = new Set(["available", "unavailable", "unknown"]);

function sanitizeCatalog(body) {
  const models = Array.isArray(body?.models) ? body.models : [];
  return {
    provider: typeof body?.provider === "string" ? body.provider : null,
    defaultModel: typeof body?.defaultModel === "string" ? body.defaultModel : null,
    models: models
      .filter((model) => typeof model?.id === "string" && model.id)
      .slice(0, 50)
      .map((model) => ({
        id: model.id,
        name: typeof model.name === "string" && model.name ? model.name : model.id,
        availability: AVAILABILITY.has(model.availability) ? model.availability : "unknown",
        isDefault: model.id === body.defaultModel,
      })),
  };
}

module.exports = { AuthManager, sanitizeCatalog, AUTH_REQUEST_TIMEOUT_MS };
