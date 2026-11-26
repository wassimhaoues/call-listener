// services/platformAudio/index.js
//
// Shared platform-audio adapter for the Electron main process. main.js talks
// only to this interface; it never branches on the operating system itself.
//
// Every adapter exposes:
//   kind                      stable adapter identifier (diagnostics only)
//   controlsOsRouting         true when the adapter changes OS audio routing
//                             (drives whether the tray routing toggle exists)
//   prepare()                 one-time setup before the window opens
//                             -> { ok: true } | { ok: false, error: { code } }
//   ensureReady()             startup gate after auth
//                             -> { status: "ready" | "needs-device" | "error" }
//   offerDeviceInstall()      start an optional device installer (non-blocking)
//   waitForDevice(onReady)    poll until the capture device appears
//   enableRouting()           idempotent; no-op when already active
//   disableRouting()          idempotent; no-op when inactive
//   isRoutingActive()
//   recoverIfDirty()          restore state left by a previous crash
//   onSuspend() / onResume()  powerMonitor hooks (never throw)
//   gracefulExit()            idempotent; later calls share the first result
//   describe()                renderer-safe snapshot for the diagnostics page
//                             (no paths, device IDs, or raw error messages)
const { createWindowsAudioAdapter } = require("./windowsAdapter");
const { createLinuxAudioAdapter } = require("./linuxAdapter");
const { createUnsupportedAudioAdapter } = require("./unsupportedAdapter");

/**
 * Choose the adapter from platform capabilities rather than raw OS checks.
 *
 * @param {object} opts
 * @param {string} opts.platform          process.platform value
 * @param {object} opts.capabilities      result of getPlatformCapabilities()
 * @param {object} [opts.logger]          console-compatible logger
 * @param {object} [opts.fs]              fs-compatible module (existsSync)
 * @param {object} [opts.windows]         Windows-only hooks:
 *   ensureTools: async () => svvPath | undefined   (may show UI)
 *   createManager: (svvPath) => AudioRouteManager-compatible object
 */
function createPlatformAudio({
  platform,
  capabilities,
  logger = console,
  fs,
  windows = {},
} = {}) {
  if (!capabilities?.appSupported) {
    return createUnsupportedAudioAdapter({ platform, logger });
  }
  if (capabilities.systemAudio?.strategy === "vb-cable") {
    return createWindowsAudioAdapter({ logger, fs, ...windows });
  }
  if (platform === "linux") {
    return createLinuxAudioAdapter({ logger, capabilities });
  }
  // A supported platform without a known adapter: fail closed to the inert
  // adapter so no OS routing command is ever attempted.
  return createUnsupportedAudioAdapter({ platform, logger });
}

module.exports = { createPlatformAudio };
