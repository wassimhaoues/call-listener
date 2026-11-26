// preload.js
const { contextBridge, ipcRenderer } = require("electron");

const isDev = process.env.NODE_ENV === "development";

// Expose a tiny, safe API
contextBridge.exposeInMainWorld("callApi", {
  getWsUrl: () => ipcRenderer.invoke("auth:getWsUrl"),
  getPlatformCapabilities: () => ipcRenderer.invoke("platform:getCapabilities"),
  // Linux Setup only: resolves { ok: true } or { ok: false, code }.
  createInterviewerSource: () => ipcRenderer.invoke("audio:createInterviewerSource"),
  getModels: () => ipcRenderer.invoke("models:list"),
  // Tells main whether an interview is capturing audio (tray status and the
  // close-to-tray notice). Only a boolean crosses the bridge.
  setInterviewActive: (active) => ipcRenderer.send("session:interviewActive", active === true),
  // Explicit candidate action only: resolves { ok, brief, model } or { ok: false, error }.
  generatePreparationBrief: (context) => ipcRenderer.invoke("preparation:brief", context),
  // Renderer-safe diagnostics snapshot (no host identifiers, no paths).
  // Only the interviewer source kind (an enum string) is forwarded.
  getDiagnostics: (request) =>
    ipcRenderer.invoke("diagnostics:get", {
      interviewerSource:
        typeof request?.interviewerSource === "string" ? request.interviewerSource : undefined,
    }),
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
