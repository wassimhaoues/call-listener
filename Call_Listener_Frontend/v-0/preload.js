// preload.js
const { contextBridge, ipcRenderer } = require("electron");

const isDev = process.env.NODE_ENV === "development";

// Expose a tiny, safe API
contextBridge.exposeInMainWorld("callApi", {
  getWsUrl: () => ipcRenderer.invoke("auth:getWsUrl"),
  getPlatformCapabilities: () => ipcRenderer.invoke("platform:getCapabilities"),
  getModels: () => ipcRenderer.invoke("models:list"),
  // Renderer-safe diagnostics snapshot (no host identifiers, no paths).
  getDiagnostics: () => ipcRenderer.invoke("diagnostics:get"),
});

// Optional: silence console output from renderer in production
if (!isDev) {
  const noop = () => {};
  globalThis.console = {
    log: noop,
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    table: noop,
    group: noop,
    groupCollapsed: noop,
    groupEnd: noop,
    time: noop,
    timeEnd: noop,
  };
}
