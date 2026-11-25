// services/security.js
function hardenSessionSecurity(sess, opts) {
  const { isDev, devKey, devOrigin, prodWsOrigins } = opts;

  // Permission requests: allow mic/camera only from file:// or dev origin
  sess.setPermissionRequestHandler((wc, permission, callback) => {
    const url = wc.getURL() || "";
    const isFile = url.startsWith("file://");
    const isDevOrigin = isDev && url.startsWith(devOrigin);
    const mediaPerms = new Set([
      "media",
      "microphone",
      "camera",
      "audioCapture",
      "videoCapture",
    ]);
    callback((isFile || isDevOrigin) && mediaPerms.has(permission));
  });

  // Newer Electron also checks here—allow consistently:
  if (typeof sess.setPermissionCheckHandler === "function") {
    sess.setPermissionCheckHandler(
      (_wc, permission, requestingOrigin, details) => {
        const origin = requestingOrigin || details?.securityOrigin || "";
        const isFile =
          origin.startsWith("file://") ||
          origin === ""; /* file pages often report "" */
        const isDevOrigin = isDev && origin.startsWith(devOrigin);
        const mediaPerms = new Set([
          "media",
          "microphone",
          "camera",
          "audioCapture",
          "videoCapture",
        ]);
        return (isFile || isDevOrigin) && mediaPerms.has(permission);
      }
    );
  }

  // Dev-only: inject X-Electron-Key only for requests to dev server
  sess.webRequest.onBeforeSendHeaders((details, callback) => {
    if (isDev && details.url.startsWith(devOrigin)) {
      details.requestHeaders["X-Electron-Key"] = devKey;
    }
    callback({ requestHeaders: details.requestHeaders });
  });

  // Production CSP (response header)
  if (!isDev) {
    const csp =
      "default-src 'self'; " +
      "base-uri 'self'; " +
      "script-src 'self'; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob:; " +
      `connect-src 'self' ${prodWsOrigins.join(" ")}; ` +
      "media-src 'self' blob:; " +
      "object-src 'none'; " +
      "frame-ancestors 'none'";

    sess.webRequest.onHeadersReceived((details, callback) => {
      const headers = details.responseHeaders || {};
      headers["Content-Security-Policy"] = [csp];
      callback({ responseHeaders: headers });
    });
  }
}

module.exports = { hardenSessionSecurity };
