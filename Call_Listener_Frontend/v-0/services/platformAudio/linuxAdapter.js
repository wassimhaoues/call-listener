// services/platformAudio/linuxAdapter.js
//
// Linux never changes OS audio routing: no sound-server commands, no virtual
// sinks, no default-device changes. The adapter owns only streams the app
// itself registers (trackStream) and stops exactly those on disable/exit.
//
// Until L2 (PipeWire desktop capture) is qualified it reports microphone-only
// capture regardless of what the capability probe says about PipeWire.
function createLinuxAudioAdapter({ logger = console } = {}) {
  const streams = new Map(); // id -> { stop }
  let state = "idle"; // idle | prepared | ready | exited
  let lastError = null;

  const stopAll = () => {
    let stopped = 0;
    for (const [id, handle] of streams) {
      streams.delete(id);
      try {
        handle.stop();
        stopped += 1;
      } catch (e) {
        lastError = { code: "stream-stop-failed" };
        logger.warn("[audio] app stream stop failed:", e?.message || e);
      }
    }
    return stopped;
  };

  return {
    kind: "linux-app-streams",
    controlsOsRouting: false,

    async prepare() {
      if (state === "idle") state = "prepared";
      return { ok: true };
    },

    async ensureReady() {
      if (state !== "exited") state = "ready";
      return { status: "ready" };
    },

    offerDeviceInstall() {
      return Promise.resolve(false);
    },

    waitForDevice() {},

    isRoutingActive() {
      return false;
    },

    /**
     * Register a stream the app created so it is stopped on exit. Returns an
     * untrack function. Streams the app did not create are never touched.
     */
    trackStream(id, handle) {
      if (state === "exited") throw new Error("Linux audio adapter has exited");
      if (!id || typeof handle?.stop !== "function") {
        throw new TypeError("trackStream requires an id and a { stop } handle");
      }
      streams.set(id, handle);
      return () => streams.delete(id);
    },

    activeStreamCount() {
      return streams.size;
    },

    async enableRouting() {
      return { changed: false, reason: "not-supported" };
    },

    async disableRouting() {
      return { changed: stopAll() > 0 };
    },

    async recoverIfDirty() {
      // Nothing persisted, nothing to restore at the OS level.
      streams.clear();
    },

    async onSuspend() {
      stopAll();
    },

    async onResume() {},

    async gracefulExit() {
      if (state === "exited") return;
      stopAll();
      state = "exited";
    },

    describe() {
      return {
        kind: "linux-app-streams",
        controlsOsRouting: false,
        captureStrategy: "microphone-only",
        systemAudioAvailable: false,
        state,
        routingActive: false,
        activeStreams: streams.size,
        lastErrorCode: lastError?.code || null,
      };
    },
  };
}

module.exports = { createLinuxAudioAdapter };
