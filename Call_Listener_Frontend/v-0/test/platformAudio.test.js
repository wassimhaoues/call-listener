import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";

const { createPlatformAudio } = require("../services/platformAudio/index.js");
const { createLinuxAudioAdapter } = require("../services/platformAudio/linuxAdapter.js");
const {
  createWindowsAudioAdapter,
  CABLE_RENDER_DEVICE,
} = require("../services/platformAudio/windowsAdapter.js");
const { AudioRouteManager } = require("../services/audio.js");
const { getPlatformCapabilities } = require("../services/platformCapabilities.js");

const SVV = "C:\\fake\\SoundVolumeView.exe";
const USER_DATA = "C:\\fake\\userData";
const SPEAKERS = "Realtek\\Device\\Speakers\\Render";

const silentLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

// AudioRouteManager joins process.resourcesPath when looking for the
// watchdog; Electron defines it, plain Node does not.
const originalResourcesPath = process.resourcesPath;
beforeAll(() => {
  if (!process.resourcesPath) process.resourcesPath = os.tmpdir();
});
afterAll(() => {
  process.resourcesPath = originalResourcesPath;
});

/** In-memory fs: only files written through it exist (so no watchdog spawn). */
function makeFakeFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    existsSync: (p) => files.has(p),
    readFileSync: (p) => {
      if (!files.has(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files.get(p);
    },
    writeFileSync: (p, data) => files.set(p, String(data)),
    unlinkSync: (p) => {
      if (!files.delete(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  };
}

/** Fake child_process that records SoundVolumeView calls instead of running them. */
function makeFakeChildProcess(fakeFs, { cablePresent = true, failOn = null } = {}) {
  const calls = [];
  const cp = {
    calls,
    cablePresent,
    exec: vi.fn((cmd, opts, cb) => {
      calls.push(["exec", "/scomma"]);
      const rows = ["Name,Device Name", "Speakers,Realtek"];
      if (cp.cablePresent) rows.push("CABLE Output,VB-Audio Virtual Cable");
      cb(null, rows.join("\n"));
    }),
    execFile: vi.fn((file, args, opts, cb) => {
      calls.push(args);
      if (failOn && args[0] === failOn) return cb(new Error(`${failOn} failed at ${SVV}`));
      if (args[0] === "/scomma") {
        fakeFs.writeFileSync(
          args[1],
          [
            "Name,Default,Command-Line Friendly ID,Device Name",
            `Speakers,Render,${SPEAKERS},Realtek`,
          ].join("\n")
        );
      }
      cb(null);
    }),
    spawn: vi.fn(() => {
      throw new Error("spawn must not run in tests");
    }),
  };
  return cp;
}

function makeWindows({ cablePresent = true, failOn = null, svvPath = SVV } = {}) {
  const fakeFs = makeFakeFs({ [SVV]: "binary" });
  const cp = makeFakeChildProcess(fakeFs, { cablePresent, failOn });
  const createManager = vi.fn(
    (resolved) =>
      new AudioRouteManager({
        svvPath: resolved,
        vbCableInstaller: "",
        userDataDir: USER_DATA,
        logger: silentLogger,
        childProcess: cp,
        fs: fakeFs,
      })
  );
  const adapter = createPlatformAudio({
    platform: "win32",
    capabilities: getPlatformCapabilities({ platform: "win32" }),
    logger: silentLogger,
    fs: fakeFs,
    windows: { ensureTools: vi.fn(async () => svvPath), createManager },
  });
  return { adapter, cp, fakeFs, createManager };
}

const svvCommands = (cp) => cp.calls.map((c) => c.join(" "));

describe("createPlatformAudio adapter choice", () => {
  it("wraps VB-Cable routing on Windows", () => {
    const { adapter } = makeWindows();
    expect(adapter.kind).toBe("windows-vb-cable");
    expect(adapter.controlsOsRouting).toBe(true);
  });

  it("uses the app-stream adapter on Linux, mic-only even when PipeWire is probed", () => {
    for (const caps of [
      getPlatformCapabilities({ platform: "linux" }),
      getPlatformCapabilities({ platform: "linux", hasPipeWire: true, hasDisplayServer: true }),
    ]) {
      const adapter = createPlatformAudio({ platform: "linux", capabilities: caps });
      expect(adapter.kind).toBe("linux-app-streams");
      expect(adapter.controlsOsRouting).toBe(false);
      expect(adapter.describe().captureStrategy).toBe("microphone-only");
      expect(adapter.describe().systemAudioAvailable).toBe(false);
    }
  });

  it("returns an inert adapter for unsupported platforms", async () => {
    const adapter = createPlatformAudio({
      platform: "darwin",
      capabilities: getPlatformCapabilities({ platform: "darwin" }),
    });
    expect(adapter.kind).toBe("unsupported");
    expect(await adapter.prepare()).toEqual({ ok: true });
    expect(await adapter.enableRouting()).toMatchObject({ changed: false });
    expect(adapter.describe().lastErrorCode).toBe("unsupported-platform");
  });

  it("requires the Windows tool hooks instead of guessing paths", () => {
    expect(() => createWindowsAudioAdapter({})).toThrow(TypeError);
  });
});

describe("Windows adapter (AudioRouteManager behind the interface)", () => {
  it("runs the same SoundVolumeView sequence as before on startup and exit", async () => {
    const { adapter, cp } = makeWindows();

    expect(await adapter.prepare()).toEqual({ ok: true });
    expect(await adapter.ensureReady()).toEqual({ status: "ready" });
    expect(adapter.isRoutingActive()).toBe(true);
    expect(svvCommands(cp)).toEqual([
      "exec /scomma",
      expect.stringMatching(/^\/scomma .*svv_\d+\.csv$/),
      "/SetListenToThisDevice VB-Audio Virtual Cable 1",
      `/SetPlaybackThroughDevice VB-Audio Virtual Cable ${SPEAKERS}`,
      `/SetDefault ${CABLE_RENDER_DEVICE} all`,
    ]);

    cp.calls.length = 0;
    await adapter.gracefulExit();
    expect(svvCommands(cp)).toEqual([
      `/SetDefault ${SPEAKERS} all`,
      "/SetListenToThisDevice VB-Audio Virtual Cable 0",
    ]);
    expect(adapter.isRoutingActive()).toBe(false);
    expect(adapter.describe().state).toBe("exited");
  });

  it("restores a dirty state left by a crash before enabling", async () => {
    const { adapter, cp, fakeFs } = makeWindows();
    fakeFs.writeFileSync(
      path.join(USER_DATA, "audio_state.json"),
      JSON.stringify({ pendingRestore: true, defaultDevice: SPEAKERS })
    );
    await adapter.prepare();
    await adapter.ensureReady();
    expect(svvCommands(cp).slice(0, 2)).toEqual([
      `/SetDefault ${SPEAKERS} all`,
      "/SetListenToThisDevice VB-Audio Virtual Cable 0",
    ]);
  });

  it("treats double enable, double disable, and double exit as no-ops", async () => {
    const { adapter, cp } = makeWindows();
    await adapter.prepare();
    await adapter.ensureReady();
    cp.calls.length = 0;

    expect(await adapter.enableRouting()).toEqual({ changed: false, reason: "already-active" });
    expect(cp.calls).toEqual([]);

    expect(await adapter.disableRouting()).toEqual({ changed: true });
    expect(await adapter.disableRouting()).toEqual({ changed: false, reason: "already-inactive" });
    expect(svvCommands(cp)).toEqual(["/SetListenToThisDevice VB-Audio Virtual Cable 0"]);

    cp.calls.length = 0;
    const [a, b] = [adapter.gracefulExit(), adapter.gracefulExit()];
    expect(a).toBe(b);
    await a;
    await adapter.gracefulExit();
    // Inactive at exit: AudioRouteManager still disables listen exactly once.
    expect(svvCommands(cp)).toEqual(["/SetListenToThisDevice VB-Audio Virtual Cable 0"]);
  });

  it("serializes concurrent enables so routing is applied once", async () => {
    const { adapter, cp } = makeWindows();
    await adapter.prepare();
    const results = await Promise.all([adapter.enableRouting(), adapter.enableRouting()]);
    expect(results).toEqual([{ changed: true }, { changed: false, reason: "already-active" }]);
    expect(svvCommands(cp).filter((c) => c.includes("/SetListenToThisDevice"))).toEqual([
      "/SetListenToThisDevice VB-Audio Virtual Cable 1",
    ]);
  });

  it("refuses to re-enable routing after exit (e.g. resume during quit)", async () => {
    const { adapter, cp } = makeWindows();
    await adapter.prepare();
    await adapter.gracefulExit();
    cp.calls.length = 0;
    await adapter.onResume();
    expect(cp.calls).toEqual([]);
    expect(await adapter.enableRouting()).toEqual({ changed: false, reason: "exited" });
  });

  it("disables on suspend and re-enables on resume without throwing", async () => {
    const { adapter, cp } = makeWindows();
    await adapter.prepare();
    await adapter.ensureReady();
    await adapter.onSuspend();
    expect(adapter.isRoutingActive()).toBe(false);
    await adapter.onResume();
    expect(adapter.isRoutingActive()).toBe(true);
    expect(svvCommands(cp)).toContain("/SetListenToThisDevice VB-Audio Virtual Cable 0");
  });

  it("reports a missing SoundVolumeView without creating a manager", async () => {
    const { adapter, createManager } = makeWindows({ svvPath: null });
    expect(await adapter.prepare()).toEqual({
      ok: false,
      error: { code: "sound-tool-missing" },
    });
    expect(createManager).not.toHaveBeenCalled();
    expect(adapter.describe()).toMatchObject({ state: "error", lastErrorCode: "sound-tool-missing" });
  });

  it("reports a missing VB-Cable and enters the app once polling finds it", async () => {
    const { adapter, cp } = makeWindows({ cablePresent: false });
    await adapter.prepare();
    expect(await adapter.ensureReady()).toEqual({ status: "needs-device" });
    expect(adapter.describe()).toMatchObject({
      state: "waiting-for-device",
      lastErrorCode: "vb-cable-missing",
      routingActive: false,
    });

    cp.cablePresent = true;
    await new Promise((resolve) => adapter.waitForDevice(resolve, 5));
    expect(adapter.describe()).toMatchObject({ state: "ready", lastErrorCode: null, routingActive: true });
    expect(svvCommands(cp)).toContain(`/SetDefault ${CABLE_RENDER_DEVICE} all`);
    await adapter.gracefulExit();
  });

  it("maps startup and toggle failures to codes without leaking raw messages", async () => {
    const { adapter } = makeWindows({ failOn: "/SetListenToThisDevice" });
    await adapter.prepare();
    expect(await adapter.ensureReady()).toEqual({ status: "error" });
    const described = adapter.describe();
    expect(described).toMatchObject({ state: "error", lastErrorCode: "startup-failed" });
    expect(JSON.stringify(described)).not.toContain("fake");

    await expect(adapter.enableRouting()).rejects.toThrow(/SetListenToThisDevice failed/);
    expect(adapter.describe().lastErrorCode).toBe("routing-failed");
    // Power hooks swallow the same failure.
    await expect(adapter.onResume()).resolves.toBeUndefined();
  });

  it("rejects lifecycle calls before prepare()", async () => {
    const { adapter } = makeWindows();
    await expect(adapter.enableRouting()).rejects.toThrow(/before prepare/);
    expect(await adapter.ensureReady()).toEqual({ status: "error" });
    await expect(adapter.onSuspend()).resolves.toBeUndefined();
  });
});

describe("Linux adapter", () => {
  it("never loads child_process or changes OS routing", () => {
    const source = nodeFs.readFileSync(
      path.join(__dirname, "../services/platformAudio/linuxAdapter.js"),
      "utf8"
    );
    expect(source).not.toMatch(/require\(["'](node:)?child_process["']\)/);
    expect(source).not.toMatch(/pactl|pw-cli|wpctl/);
  });

  it("reaches ready in microphone-only mode", async () => {
    const adapter = createLinuxAudioAdapter({ logger: silentLogger });
    expect(await adapter.prepare()).toEqual({ ok: true });
    expect(await adapter.ensureReady()).toEqual({ status: "ready" });
    expect(await adapter.enableRouting()).toEqual({ changed: false, reason: "not-supported" });
    expect(adapter.isRoutingActive()).toBe(false);
    expect(adapter.describe()).toMatchObject({
      kind: "linux-app-streams",
      captureStrategy: "microphone-only",
      state: "ready",
      lastErrorCode: null,
    });
  });

  it("stops only app-registered streams, once, across disable and exit", async () => {
    const adapter = createLinuxAudioAdapter({ logger: silentLogger });
    const mine = { stop: vi.fn() };
    const released = { stop: vi.fn() };
    adapter.trackStream("mic", mine);
    const untrack = adapter.trackStream("old", released);
    untrack();
    expect(adapter.activeStreamCount()).toBe(1);

    expect(await adapter.disableRouting()).toEqual({ changed: true });
    expect(await adapter.disableRouting()).toEqual({ changed: false });
    await adapter.gracefulExit();
    await adapter.gracefulExit();

    expect(mine.stop).toHaveBeenCalledTimes(1);
    expect(released.stop).not.toHaveBeenCalled();
    expect(adapter.describe().state).toBe("exited");
    expect(() => adapter.trackStream("late", { stop() {} })).toThrow(/exited/);
  });

  it("keeps exiting when a stream fails to stop and reports a code", async () => {
    const adapter = createLinuxAudioAdapter({ logger: silentLogger });
    const ok = { stop: vi.fn() };
    adapter.trackStream("bad", { stop: () => { throw new Error("boom"); } });
    adapter.trackStream("ok", ok);
    await adapter.gracefulExit();
    expect(ok.stop).toHaveBeenCalledTimes(1);
    expect(adapter.describe().lastErrorCode).toBe("stream-stop-failed");
  });

  it("validates stream handles", () => {
    const adapter = createLinuxAudioAdapter({ logger: silentLogger });
    expect(() => adapter.trackStream("x", {})).toThrow(TypeError);
    expect(() => adapter.trackStream("", { stop() {} })).toThrow(TypeError);
  });
});
