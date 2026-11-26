import { describe, expect, it } from "vitest";

const { buildDiagnostics, detectDisplayServer, ERROR_CATALOG } = require("../services/diagnostics.js");
const { getPlatformCapabilities } = require("../services/platformCapabilities.js");
const { createPlatformAudio } = require("../services/platformAudio/index.js");

const HOST_IDENTIFIERS = {
  HOSTNAME: "alice-laptop",
  USER: "alice",
  USERNAME: "alice",
  LOGNAME: "alice",
  HOME: "/home/alice",
  USERPROFILE: "C:\\Users\\alice",
  COMPUTERNAME: "ALICE-PC",
  SSH_CONNECTION: "192.168.1.20 53422 192.168.1.5 22",
  INSTALLATION_ID: "44d8a725-37db-4cc2-82ed-6d9e23c0db98",
};

const linuxAudio = () =>
  createPlatformAudio({
    platform: "linux",
    capabilities: getPlatformCapabilities({ platform: "linux" }),
  }).describe();

describe("detectDisplayServer", () => {
  it("prefers XDG_SESSION_TYPE, then WAYLAND_DISPLAY, then DISPLAY", () => {
    expect(detectDisplayServer("linux", { XDG_SESSION_TYPE: "wayland" })).toBe("wayland");
    expect(detectDisplayServer("linux", { XDG_SESSION_TYPE: "X11", WAYLAND_DISPLAY: "w-0" })).toBe("x11");
    expect(detectDisplayServer("linux", { WAYLAND_DISPLAY: "wayland-0" })).toBe("wayland");
    expect(detectDisplayServer("linux", { DISPLAY: ":0" })).toBe("x11");
    expect(detectDisplayServer("linux", { XDG_SESSION_TYPE: "tty" })).toBe("unknown");
    expect(detectDisplayServer("linux", {})).toBe("unknown");
  });

  it("is not applicable outside Linux", () => {
    expect(detectDisplayServer("win32", { DISPLAY: ":0" })).toBe("n/a");
  });
});

describe("buildDiagnostics", () => {
  it("describes Linux microphone-only mode with an actionable note", () => {
    const result = buildDiagnostics({
      platform: "linux",
      arch: "x64",
      env: { XDG_SESSION_TYPE: "wayland" },
      capabilities: getPlatformCapabilities({ platform: "linux" }),
      audio: linuxAudio(),
      appVersion: "1.0.0",
      electronVersion: "44.4.5",
    });
    expect(result).toEqual({
      os: { family: "Linux", arch: "x64", supported: true },
      displayServer: "wayland",
      capture: {
        strategy: "microphone-only",
        label: "Microphone only",
        systemAudio: false,
        interviewerSource: { kind: "unknown", label: "Not chosen yet" },
      },
      audioAdapter: {
        kind: "linux-app-streams",
        state: "idle",
        controlsOsRouting: false,
        routingActive: false,
      },
      versions: { app: "1.0.0", electron: "44.4.5" },
      errors: [{ code: "system-audio-unavailable", ...ERROR_CATALOG["system-audio-unavailable"] }],
    });
  });

  it("describes Windows VB-Cable capture and maps adapter error codes to fixed copy", () => {
    const result = buildDiagnostics({
      platform: "win32",
      arch: "x64",
      env: {},
      capabilities: getPlatformCapabilities({ platform: "win32" }),
      audio: {
        kind: "windows-vb-cable",
        controlsOsRouting: true,
        captureStrategy: "system-and-microphone",
        systemAudioAvailable: false,
        state: "waiting-for-device",
        routingActive: false,
        lastErrorCode: "vb-cable-missing",
      },
      appVersion: "1.0.0",
      electronVersion: "44.4.5",
    });
    expect(result.displayServer).toBe("n/a");
    expect(result.capture.label).toBe("System audio and microphone (VB-Cable)");
    expect(result.errors.map((e) => e.code)).toEqual(["vb-cable-missing"]);
    expect(result.errors[0].action).toMatch(/Install VB-CABLE/);
  });

  it("reports a selected Linux monitor source by kind only", () => {
    const result = buildDiagnostics({
      platform: "linux",
      capabilities: getPlatformCapabilities({ platform: "linux" }),
      audio: linuxAudio(),
      interviewerSource: "monitor-source",
    });
    expect(result.capture.interviewerSource).toEqual({
      kind: "monitor-source",
      label: "Monitor source selected",
    });
    // A chosen monitor replaces the "type the questions" note.
    expect(result.errors.map((e) => e.code)).not.toContain("system-audio-unavailable");
  });

  it("reports microphone-only Linux sessions with the typed-question note", () => {
    const result = buildDiagnostics({
      platform: "linux",
      capabilities: getPlatformCapabilities({ platform: "linux" }),
      audio: linuxAudio(),
      interviewerSource: "none",
    });
    expect(result.capture.interviewerSource).toEqual({ kind: "none", label: "None (typed questions)" });
    expect(result.errors.map((e) => e.code)).toContain("system-audio-unavailable");
  });

  it.each([
    "Monitor of Built-in Audio Analog Stereo",
    "alsa_output.pci-0000_00_1f.3.analog-stereo.monitor",
    "constructor",
    "__proto__",
    42,
    { kind: "monitor-source" },
  ])("never echoes an unknown interviewer source value (%s)", (value) => {
    const result = buildDiagnostics({
      platform: "linux",
      capabilities: getPlatformCapabilities({ platform: "linux" }),
      audio: linuxAudio(),
      interviewerSource: value,
    });
    expect(result.capture.interviewerSource).toEqual({ kind: "unknown", label: "Not chosen yet" });
  });

  it("flags unsupported platforms", () => {
    const result = buildDiagnostics({
      platform: "darwin",
      capabilities: getPlatformCapabilities({ platform: "darwin" }),
      audio: createPlatformAudio({
        platform: "darwin",
        capabilities: getPlatformCapabilities({ platform: "darwin" }),
      }).describe(),
    });
    expect(result.os).toMatchObject({ family: "macOS", supported: false });
    expect(result.errors.map((e) => e.code)).toEqual(["unsupported-platform"]);
  });

  it("never includes host identifiers, paths, or raw error text", () => {
    const leaky = "C:\\Users\\alice\\AppData\\SoundVolumeView.exe";
    const result = buildDiagnostics({
      platform: "linux",
      arch: "/home/alice/arch",
      env: { ...HOST_IDENTIFIERS, DISPLAY: ":0" },
      capabilities: getPlatformCapabilities({ platform: "linux" }),
      audio: {
        ...linuxAudio(),
        kind: leaky,
        state: "alice-laptop 192.168.1.20",
        lastErrorCode: `Command failed: ${leaky}`,
        svvPath: leaky,
        installationId: HOST_IDENTIFIERS.INSTALLATION_ID,
        hostname: "alice-laptop",
      },
      appVersion: "1.0.0 /home/alice",
      electronVersion: "44.4.5",
      installationId: HOST_IDENTIFIERS.INSTALLATION_ID,
    });
    const serialized = JSON.stringify(result);
    for (const value of [
      "alice",
      "ALICE",
      "Users",
      "/home",
      "192.168",
      HOST_IDENTIFIERS.INSTALLATION_ID,
      "SoundVolumeView",
      "Command failed",
    ]) {
      expect(serialized).not.toContain(value);
    }
    // Unknown error code falls back to generic copy instead of echoing it.
    expect(result.errors.map((e) => e.code)).toContain("unknown");
    expect(result.audioAdapter.kind).toBe("unknown");
    expect(result.versions.app).toBe("unknown");
    expect(Object.keys(result).sort()).toEqual(
      ["audioAdapter", "capture", "displayServer", "errors", "os", "versions"].sort()
    );
  });
});
