// services/platformAudio/unsupportedAdapter.js
//
// Inert adapter for platforms the app does not support. It never touches OS
// audio; main.js routes these platforms to the unsupported-OS page.
function createUnsupportedAudioAdapter() {
  let state = "idle";
  return {
    kind: "unsupported",
    controlsOsRouting: false,
    async prepare() {
      return { ok: true };
    },
    async ensureReady() {
      return { status: "error" };
    },
    offerDeviceInstall() {
      return Promise.resolve(false);
    },
    waitForDevice() {},
    isRoutingActive() {
      return false;
    },
    async enableRouting() {
      return { changed: false, reason: "not-supported" };
    },
    async disableRouting() {
      return { changed: false, reason: "not-supported" };
    },
    async recoverIfDirty() {},
    async onSuspend() {},
    async onResume() {},
    async gracefulExit() {
      state = "exited";
    },
    describe() {
      return {
        kind: "unsupported",
        controlsOsRouting: false,
        captureStrategy: "unavailable",
        systemAudioAvailable: false,
        state,
        routingActive: false,
        lastErrorCode: "unsupported-platform",
      };
    },
  };
}

module.exports = { createUnsupportedAudioAdapter };
