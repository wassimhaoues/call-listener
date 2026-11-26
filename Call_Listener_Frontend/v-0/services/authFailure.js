// services/authFailure.js
// Classifies why the main-process auth gate failed, so the renderer can tell
// "this computer has no network" apart from "the network works but the Call
// Listener server could not be reached or answered with an error".

const AUTH_FAILURE = Object.freeze({
  OFFLINE: "offline",
  SERVER_UNREACHABLE: "server_unreachable",
  TLS: "tls",
  HTTP: "http",
});

// Node/OpenSSL error codes raised when the TLS handshake or certificate check
// fails (expired/self-signed/untrusted certificates, intercepting proxies).
const TLS_ERROR_CODE =
  /^(CERT_|ERR_TLS_|ERR_SSL_|ERR_OSSL_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|HOSTNAME_MISMATCH$)/;

/**
 * @param {unknown} error  The error thrown by AuthManager.ensure().
 * @param {{ online?: boolean }} network  `online` is Electron's net.isOnline().
 * @returns {"offline"|"server_unreachable"|"tls"|"http"}
 */
function classifyAuthFailure(error, { online = true } = {}) {
  if (!online) return AUTH_FAILURE.OFFLINE;
  if (Number.isInteger(error?.statusCode)) return AUTH_FAILURE.HTTP;
  const code = typeof error?.code === "string" ? error.code : "";
  if (TLS_ERROR_CODE.test(code)) return AUTH_FAILURE.TLS;
  // DNS failures, refused/reset connections, timeouts, malformed responses:
  // the network is up, but the server could not be used.
  return AUTH_FAILURE.SERVER_UNREACHABLE;
}

module.exports = { AUTH_FAILURE, classifyAuthFailure };
