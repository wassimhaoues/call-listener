// services/platformAudio/windowsAdapter.js
//
// Wraps the existing AudioRouteManager (services/audio.js) without changing
// what it does to Windows audio. The adapter adds only:
//   - redundant-call guards (enable while active / disable while inactive),
//   - serialization of routing changes so suspend/resume/tray cannot overlap,
//   - a memoized gracefulExit so double quit paths restore once,
//   - error codes for the diagnostics page (raw messages stay in the log).
const nodeFs = require("node:fs");

const CABLE_RENDER_DEVICE = String.raw`VB-Audio Virtual Cable\Device\CABLE Input\Render`;
const DEFAULT_POLL_MS = 3000;

function createWindowsAudioAdapter({
  logger = console,
  fs = nodeFs,
  ensureTools,
  createManager,
} = {}) {
  if (typeof ensureTools !== "function" || typeof createManager !== "function") {
    throw new TypeError("Windows audio adapter requires ensureTools and createManager");
  }

  let manager = null;
  let state = "idle"; // idle | prepared | waiting-for-device | ready | error | exited
  let lastError = null;
  let exitPromise = null;
  let queue = Promise.resolve();

  const serialize = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  const fail = (code, err, context) => {
    lastError = { code };
    logger.error(`[audio] ${context}:`, err);
  };

  const requireManager = () => {
    if (!manager) throw new Error("Windows audio adapter used before prepare()");
    return manager;
  };

  const activateCable = async () => {
    const m = requireManager();
    if (!m.isActive()) await m.enable();
    await m.setDefault(CABLE_RENDER_DEVICE);
    state = "ready";
    lastError = null;
  };

  return {
    kind: "windows-vb-cable",
    controlsOsRouting: true,

    async prepare() {
      if (manager) return { ok: true };
      const svvPath = await ensureTools();
      if (!svvPath || !fs.existsSync(svvPath)) {
        state = "error";
        lastError = { code: "sound-tool-missing" };
        return { ok: false, error: lastError };
      }
      manager = createManager(svvPath);
      state = "prepared";
      return { ok: true };
    },

    async ensureReady() {
      try {
        const m = requireManager();
        await m.recoverIfDirty(); // restore if previous crash
        const cableOk = await m.detectVBCable();
        if (!cableOk) {
          logger.warn("[audio] VB-Cable not detected; offering install and polling...");
          state = "waiting-for-device";
          lastError = { code: "vb-cable-missing" };
          return { status: "needs-device" };
        }
        await serialize(activateCable);
        return { status: "ready" };
      } catch (e) {
        state = "error";
        fail("startup-failed", e, "startup error");
        return { status: "error" };
      }
    },

    offerDeviceInstall() {
      return requireManager().offerInstall();
    },

    waitForDevice(onReady, everyMs = DEFAULT_POLL_MS) {
      requireManager().pollForCable(async () => {
        try {
          await serialize(activateCable);
        } catch (e) {
          state = "error";
          fail("routing-failed", e, "enable after cable detection failed");
          throw e;
        }
        await onReady?.();
      }, everyMs);
    },

    isRoutingActive() {
      return Boolean(manager?.isActive());
    },

    enableRouting() {
      return serialize(async () => {
        if (state === "exited") return { changed: false, reason: "exited" };
        const m = requireManager();
        if (m.isActive()) return { changed: false, reason: "already-active" };
        try {
          await m.enable();
        } catch (e) {
          fail("routing-failed", e, "enable failed");
          throw e;
        }
        return { changed: true };
      });
    },

    disableRouting() {
      return serialize(async () => {
        const m = requireManager();
        if (!m.isActive()) return { changed: false, reason: "already-inactive" };
        try {
          await m.disable();
        } catch (e) {
          fail("routing-failed", e, "disable failed");
          throw e;
        }
        return { changed: true };
      });
    },

    async recoverIfDirty() {
      await requireManager().recoverIfDirty();
    },

    async onSuspend() {
      if (!manager) return;
      logger.log("[power] suspend: disabling cable listen");
      await this.disableRouting().catch(() => {});
    },

    async onResume() {
      if (!manager) return;
      logger.log("[power] resume: restoring cable listen");
      await this.enableRouting().catch(() => {});
    },

    gracefulExit() {
      if (!exitPromise) {
        exitPromise = (async () => {
          // AudioRouteManager.gracefulExit catches and logs its own errors.
          if (manager) await manager.gracefulExit();
          state = "exited";
        })();
      }
      return exitPromise;
    },

    describe() {
      return {
        kind: "windows-vb-cable",
        controlsOsRouting: true,
        captureStrategy: "system-and-microphone",
        systemAudioAvailable: state === "ready",
        state,
        routingActive: Boolean(manager?.isActive()),
        lastErrorCode: lastError?.code || null,
      };
    },
  };
}

module.exports = { createWindowsAudioAdapter, CABLE_RENDER_DEVICE };
