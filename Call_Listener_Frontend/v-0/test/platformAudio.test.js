import { describe, expect, it, vi } from "vitest";
import nodeFs from "node:fs";
import path from "node:path";

const { createPlatformAudio } = require("../services/platformAudio/index.js");
const { createLinuxAudioAdapter } = require("../services/platformAudio/linuxAdapter.js");
const {
  createWindowsAudioAdapter,
  CABLE_RENDER_DEVICE,
} = require("../services/platformAudio/windowsAdapter.js");
const { AudioRouteManager } = require("../services/audio.js");
const { getPlatformCapabilities } = require("../services/platformCapabilities.js");

const SVV = String.raw`C:\fake\SoundVolumeView.exe`;
const SPEAKERS = String.raw`Realtek\Device\Speakers\Render`;

const silentLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
// Stand-in for linuxInterviewerSource so adapter tests never run pactl.
const fakeRemap = (result = { ok: true, label: "Monitor of system output (Call Listener)" }) => ({
  create: vi.fn(async () => result),
  remove: vi.fn(async () => ({ ok: true, removed: 0 })),
});

// The public AudioRouteManager methods the Windows adapter relies on. The
// fake below must keep this exact surface so it cannot drift from the real one.
const MANAGER_API = [
  "isActive",
  "detectVBCable",
  "enable",
  "disable",
  "setDefault",
  "gracefulExit",
  "recoverIfDirty",
  "pollForCable",
  "offerInstall",
];

/**
 * In-memory stand-in for AudioRouteManager. It records each OS-affecting call
 * and models the same state rules: enable() saves the default device,
 * gracefulExit() restores it only while active and always disables listening.
 */
function makeFakeManager({ cablePresent = true, failOn = null, dirty = false } = {}) {
  const calls = [];
  const m = {
    calls,
    cablePresent,
    active: false,
    pending: dirty ? { defaultDevice: SPEAKERS } : null,
    _maybeFail(name) {
      if (failOn === name) throw new Error(`${name} failed at ${SVV}`);
    },
    isActive: () => m.active,
    async detectVBCable() {
      calls.push("detectVBCable");
      return m.cablePresent;
    },
    async enable() {
      calls.push("enable");
      m._maybeFail("enable");
      m.pending = { defaultDevice: SPEAKERS };
      m.active = true;
    },
    async disable() {
      calls.push("disable");
      m._maybeFail("disable");
      m.pending = null;
      m.active = false;
    },
    async setDefault(device) {
      calls.push(`setDefault ${device}`);
      m._maybeFail("setDefault");
    },
    async gracefulExit() {
      calls.push("gracefulExit");
      if (m.active && m.pending) await m.setDefault(m.pending.defaultDevice);
      await m.disable().catch(() => {});
    },
    async recoverIfDirty() {
      calls.push("recoverIfDirty");
      if (m.pending) {
        calls.push(`restore ${m.pending.defaultDevice}`);
        m.pending = null;
      }
    },
    pollForCable(onDetect, everyMs) {
      const timer = setInterval(async () => {
        if (await m.detectVBCable()) {
          clearInterval(timer);
          onDetect?.();
        }
      }, everyMs);
    },
    offerInstall: vi.fn(async () => true),
  };
  return m;
}

function makeWindows({ svvPath = SVV, ...managerOpts } = {}) {
  const manager = makeFakeManager(managerOpts);
  const createManager = vi.fn(() => manager);
  const fs = { existsSync: (p) => p === SVV };
  const adapter = createPlatformAudio({
    platform: "win32",
    capabilities: getPlatformCapabilities({ platform: "win32" }),
    logger: silentLogger,
    fs,
    windows: { ensureTools: vi.fn(async () => svvPath), createManager },
  });
  return { adapter, manager, createManager };
}

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
  it("relies only on AudioRouteManager's existing public API", () => {
    for (const method of MANAGER_API) {
      expect(typeof AudioRouteManager.prototype[method]).toBe("function");
    }
  });

  it("calls the manager in the same order as the old main.js startup and exit", async () => {
    const { adapter, manager, createManager } = makeWindows();

    expect(await adapter.prepare()).toEqual({ ok: true });
    expect(createManager).toHaveBeenCalledWith(SVV);
    expect(await adapter.ensureReady()).toEqual({ status: "ready" });
    expect(adapter.isRoutingActive()).toBe(true);
    expect(manager.calls).toEqual([
      "recoverIfDirty",
      "detectVBCable",
      "enable",
      `setDefault ${CABLE_RENDER_DEVICE}`,
    ]);

    manager.calls.length = 0;
    await adapter.gracefulExit();
    expect(manager.calls).toEqual(["gracefulExit", `setDefault ${SPEAKERS}`, "disable"]);
    expect(adapter.isRoutingActive()).toBe(false);
    expect(adapter.describe().state).toBe("exited");
  });

  it("restores a dirty state left by a crash before enabling", async () => {
    const { adapter, manager } = makeWindows({ dirty: true });
    await adapter.prepare();
    await adapter.ensureReady();
    expect(manager.calls.slice(0, 3)).toEqual([
      "recoverIfDirty",
      `restore ${SPEAKERS}`,
      "detectVBCable",
    ]);
  });

  it("treats double enable, double disable, and double exit as no-ops", async () => {
    const { adapter, manager } = makeWindows();
    await adapter.prepare();
    await adapter.ensureReady();
    manager.calls.length = 0;

    expect(await adapter.enableRouting()).toEqual({ changed: false, reason: "already-active" });
    expect(manager.calls).toEqual([]);

    expect(await adapter.disableRouting()).toEqual({ changed: true });
    expect(await adapter.disableRouting()).toEqual({ changed: false, reason: "already-inactive" });
    expect(manager.calls).toEqual(["disable"]);

    manager.calls.length = 0;
    const [a, b] = [adapter.gracefulExit(), adapter.gracefulExit()];
    expect(a).toBe(b);
    await a;
    await adapter.gracefulExit();
    // Inactive at exit: AudioRouteManager.gracefulExit still runs exactly once.
    expect(manager.calls).toEqual(["gracefulExit", "disable"]);
  });

  it("serializes concurrent enables so routing is applied once", async () => {
    const { adapter, manager } = makeWindows();
    await adapter.prepare();
    const results = await Promise.all([adapter.enableRouting(), adapter.enableRouting()]);
    expect(results).toEqual([{ changed: true }, { changed: false, reason: "already-active" }]);
    expect(manager.calls).toEqual(["enable"]);
  });

  it("refuses to re-enable routing after exit (e.g. resume during quit)", async () => {
    const { adapter, manager } = makeWindows();
    await adapter.prepare();
    await adapter.gracefulExit();
    manager.calls.length = 0;
    await adapter.onResume();
    expect(manager.calls).toEqual([]);
    expect(await adapter.enableRouting()).toEqual({ changed: false, reason: "exited" });
  });

  it("disables on suspend and re-enables on resume without throwing", async () => {
    const { adapter, manager } = makeWindows();
    await adapter.prepare();
    await adapter.ensureReady();
    manager.calls.length = 0;
    await adapter.onSuspend();
    expect(adapter.isRoutingActive()).toBe(false);
    await adapter.onResume();
    expect(adapter.isRoutingActive()).toBe(true);
    expect(manager.calls).toEqual(["disable", "enable"]);
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
    const { adapter, manager } = makeWindows({ cablePresent: false });
    await adapter.prepare();
    expect(await adapter.ensureReady()).toEqual({ status: "needs-device" });
    expect(adapter.describe()).toMatchObject({
      state: "waiting-for-device",
      lastErrorCode: "vb-cable-missing",
      routingActive: false,
    });
    await adapter.offerDeviceInstall();
    expect(manager.offerInstall).toHaveBeenCalledTimes(1);

    manager.cablePresent = true;
    await new Promise((resolve) => adapter.waitForDevice(resolve, 5));
    expect(adapter.describe()).toMatchObject({ state: "ready", lastErrorCode: null, routingActive: true });
    expect(manager.calls.slice(-2)).toEqual(["enable", `setDefault ${CABLE_RENDER_DEVICE}`]);
    await adapter.gracefulExit();
  });

  it("maps startup and toggle failures to codes without leaking raw messages", async () => {
    const { adapter } = makeWindows({ failOn: "enable" });
    await adapter.prepare();
    expect(await adapter.ensureReady()).toEqual({ status: "error" });
    const described = adapter.describe();
    expect(described).toMatchObject({ state: "error", lastErrorCode: "startup-failed" });
    expect(JSON.stringify(described)).not.toContain("fake");

    await expect(adapter.enableRouting()).rejects.toThrow(/enable failed/);
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
    const adapter = createLinuxAudioAdapter({ logger: silentLogger, interviewerSource: fakeRemap() });
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
    const adapter = createLinuxAudioAdapter({ logger: silentLogger, interviewerSource: fakeRemap() });
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
    const adapter = createLinuxAudioAdapter({ logger: silentLogger, interviewerSource: fakeRemap() });
    const ok = { stop: vi.fn() };
    adapter.trackStream("bad", { stop: () => { throw new Error("boom"); } });
    adapter.trackStream("ok", ok);
    await adapter.gracefulExit();
    expect(ok.stop).toHaveBeenCalledTimes(1);
    expect(adapter.describe().lastErrorCode).toBe("stream-stop-failed");
  });

  it("validates stream handles", () => {
    const adapter = createLinuxAudioAdapter({ logger: silentLogger, interviewerSource: fakeRemap() });
    expect(() => adapter.trackStream("x", {})).toThrow(TypeError);
    expect(() => adapter.trackStream("", { stop() {} })).toThrow(TypeError);
  });
});

describe("Linux interviewer source", () => {
  const {
    createLinuxInterviewerSource,
    ownModuleIds,
  } = require("../services/platformAudio/linuxInterviewerSource.js");

  function fakePactl({ sink = "alsa_output.pci-0000_00_1f.3.analog-stereo", modules = "", missing = false } = {}) {
    const calls = [];
    const run = vi.fn(async (args) => {
      calls.push(args);
      if (missing) throw Object.assign(new Error("spawn pactl ENOENT"), { code: "ENOENT" });
      if (args[0] === "get-default-sink") return `${sink}\n`;
      if (args[0] === "list") return modules;
      if (args[0] === "load-module") return "536870914\n";
      return "";
    });
    return { run, calls };
  }

  it("mirrors the default output's monitor under a recognisable label", async () => {
    const { run, calls } = fakePactl();
    const result = await createLinuxInterviewerSource({ run, logger: silentLogger }).create();
    expect(result).toEqual({ ok: true, label: "Monitor of system output (Call Listener)" });
    const load = calls.find((args) => args[0] === "load-module");
    expect(load).toEqual([
      "load-module",
      "module-remap-source",
      "master=alsa_output.pci-0000_00_1f.3.analog-stereo.monitor",
      "source_name=call_listener_interviewer",
      'source_properties="node.description=\\"Monitor of system output (Call Listener)\\" device.description=\\"Monitor of system output (Call Listener)\\""',
    ]);
    // Never changes the default devices.
    expect(calls.some((args) => /^set-default/.test(args[0]))).toBe(false);
  });

  it("replaces only its own earlier source", async () => {
    const modules = [
      "12\tmodule-remap-source\tmaster=x.monitor source_name=call_listener_interviewer source_properties=...",
      "13\tmodule-remap-source\tmaster=y.monitor source_name=someone_else",
      "14\tmodule-null-sink\tsink_name=call_listener_interviewer_lookalike",
    ].join("\n");
    expect(ownModuleIds(modules)).toEqual(["12"]);
    const { run, calls } = fakePactl({ modules });
    await createLinuxInterviewerSource({ run, logger: silentLogger }).create();
    expect(calls.filter((args) => args[0] === "unload-module")).toEqual([["unload-module", "12"]]);
    expect(await createLinuxInterviewerSource({ run, logger: silentLogger }).remove()).toEqual({
      ok: true,
      removed: 1,
    });
  });

  it("runs pactl only from a fixed system directory", () => {
    const { findPactl } = require("../services/platformAudio/linuxInterviewerSource.js");
    expect(findPactl((candidate) => candidate === "/bin/pactl")).toBe("/bin/pactl");
    expect(findPactl((candidate) => candidate !== "/nonexistent")).toBe("/usr/bin/pactl");
    expect(findPactl(() => false)).toBeNull();
  });

  it("refuses an unsafe sink name and reports a missing pactl by code", async () => {
    const unsafe = fakePactl({ sink: 'evil" source_name=x' });
    expect(await createLinuxInterviewerSource({ run: unsafe.run, logger: silentLogger }).create()).toEqual({
      ok: false,
      code: "no-default-output",
    });
    expect(unsafe.calls.some((args) => args[0] === "load-module")).toBe(false);

    const missing = fakePactl({ missing: true });
    const source = createLinuxInterviewerSource({ run: missing.run, logger: silentLogger });
    expect(await source.create()).toEqual({ ok: false, code: "pactl-unavailable" });
    expect(await source.remove()).toEqual({ ok: false, code: "pactl-unavailable" });
  });

  it("is created only on request and removed at startup and on exit", async () => {
    const remap = fakeRemap();
    const adapter = createLinuxAudioAdapter({ logger: silentLogger, interviewerSource: remap });
    await adapter.prepare();
    expect(remap.remove).toHaveBeenCalledTimes(1);
    expect(remap.create).not.toHaveBeenCalled();
    expect(await adapter.createInterviewerSource()).toMatchObject({ ok: true });
    await adapter.gracefulExit();
    await adapter.gracefulExit();
    expect(remap.remove).toHaveBeenCalledTimes(2);
    expect(await adapter.createInterviewerSource()).toEqual({ ok: false, code: "exited" });
  });
});
