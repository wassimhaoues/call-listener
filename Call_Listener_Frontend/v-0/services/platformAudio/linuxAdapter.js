// services/platformAudio/linuxAdapter.js
//
// Linux never changes OS audio routing: no virtual sinks and no default-device
// changes. The adapter owns only streams the app itself registers
// (trackStream) and stops exactly those on disable/exit.
//
// The one sound-server change is opt-in: on an explicit candidate action,
// createInterviewerSource() adds a remapped monitor of the default output
// (see linuxInterviewerSource.js) so Chromium can list it. That source is
// removed on exit, and any copy left by a crash is removed at startup.
//
// Until L2 (PipeWire desktop capture) is qualified it reports microphone-only
// capture regardless of what the capability probe says about PipeWire.
const { createLinuxInterviewerSource } = require("./linuxInterviewerSource");

function createLinuxAudioAdapter({ logger = console, interviewerSource } = {}) {
  const remap = interviewerSource || createLinuxInterviewerSource({ logger });
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
      if (state === "idle") {
        state = "prepared";
        // A source left by a crashed run would otherwise stay until reboot.
        await remap.remove();
      }
      return { ok: true };
    },

    /** Explicit candidate action only. Resolves { ok, label } | { ok: false, code }. */
    async createInterviewerSource() {
      if (state === "exited") return { ok: false, code: "exited" };
      return remap.create();
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
      await remap.remove();
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
