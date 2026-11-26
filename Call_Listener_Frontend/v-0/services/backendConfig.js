// services/backendConfig.js
// Where the desktop app finds its backend. Packaged builds use
// `callBackend.host` from package.json (shipped inside the app), always over
// HTTPS/WSS on 443. Development defaults to the local backend. The CALL_*
// environment variables override either (development and CI only).

const HOST_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

function resolveBackendConfig({ env = process.env, isDev = false, packageJson = {} } = {}) {
  const packagedHost = packageJson?.callBackend?.host;
  const host = env.CALL_HOST || (isDev ? "127.0.0.1" : packagedHost);
  if (typeof host !== "string" || !HOST_PATTERN.test(host)) {
    throw new Error("Backend host is not configured: set callBackend.host in package.json");
  }
  return {
    host,
    protocol: env.CALL_PROTOCOL || (isDev ? "http" : "https"),
    port: Number(env.CALL_PORT || (isDev ? 3000 : 443)),
    wsProtocol: env.CALL_WS_PROTOCOL || (isDev ? "ws" : "wss"),
    wsPort: Number(env.CALL_WS_PORT || (isDev ? 4000 : 443)),
  };
}

module.exports = { resolveBackendConfig };
