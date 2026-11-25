// services/auth.js
class AuthManager {
  /**
   * @param {{ requestClient:any, appId:string, backendHost:string, electronSession: Electron.Session }} opts
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

    this.token = null;
    this.refreshTimer = null;
  }

  _postToken(deviceId) {
    const payload = JSON.stringify({ app_id: this.appId, device_id: deviceId });
    return new Promise((resolve, reject) => {
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
              return reject(new Error(`Token HTTP ${res.statusCode}: ${buf}`));
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
      req.on("error", reject);
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

  _baseUrl(protocol, port) {
    const defaultPort = protocol === "https" || protocol === "wss" ? 443 : 80;
    const portSuffix = port === defaultPort ? "" : `:${port}`;
    return `${protocol}://${this.backendHost}${portSuffix}`;
  }
}

module.exports = { AuthManager };
