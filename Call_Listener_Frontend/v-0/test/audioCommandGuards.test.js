import { describe, expect, it } from "vitest";
import guards from "../services/audioCommandGuards.js";
import audio from "../services/audio.js";

const { assertDeviceId, assertExecutablePath, isSafeDeviceId, MAX_DEVICE_ID_LENGTH } = guards;
const { AudioRouteManager } = audio;

describe("isSafeDeviceId", () => {
  it("accepts SoundVolumeView command-line friendly IDs", () => {
    expect(isSafeDeviceId("VB-Audio Virtual Cable\\Device\\CABLE Input\\Render")).toBe(true);
    expect(isSafeDeviceId("Realtek(R) Audio\\Device\\Speakers (2- USB)\\Render")).toBe(true);
    expect(isSafeDeviceId("{0.0.0.00000000}.{a1b2c3d4-0000-1111-2222-333344445555}")).toBe(true);
    expect(isSafeDeviceId("Haut-parleurs Réalisés\\Device\\Casque\\Render")).toBe(true);
  });

  it("rejects values that could be parsed as switches or break quoting", () => {
    expect(isSafeDeviceId("/SetDefault")).toBe(false);
    expect(isSafeDeviceId("-Command")).toBe(false);
    expect(isSafeDeviceId('Speakers" /Close')).toBe(false);
    expect(isSafeDeviceId("Speakers\n/Mute")).toBe(false);
    expect(isSafeDeviceId("a;b|c")).toBe(false);
    expect(isSafeDeviceId("")).toBe(false);
    expect(isSafeDeviceId("x".repeat(MAX_DEVICE_ID_LENGTH + 1))).toBe(false);
    expect(isSafeDeviceId(null)).toBe(false);
    expect(isSafeDeviceId(42)).toBe(false);
  });

  it("assertDeviceId throws on unsafe values and returns safe ones", () => {
    expect(assertDeviceId("CABLE Input\\Render")).toBe("CABLE Input\\Render");
    expect(() => assertDeviceId("/Mute")).toThrow(TypeError);
  });
});

describe("assertExecutablePath", () => {
  const absolute = process.platform === "win32" ? "C:\\tools\\SoundVolumeView.exe" : "/opt/tools/SoundVolumeView.exe";

  it("accepts an absolute path with the expected file name, case-insensitively", () => {
    expect(assertExecutablePath(absolute, "soundvolumeview.exe")).toBe(absolute);
  });

  it("rejects relative paths, other executables, and non-strings", () => {
    expect(() => assertExecutablePath("SoundVolumeView.exe", "SoundVolumeView.exe")).toThrow(TypeError);
    expect(() => assertExecutablePath(absolute.replace("SoundVolumeView", "cmd"), "SoundVolumeView.exe")).toThrow(TypeError);
    expect(() => assertExecutablePath(undefined, "SoundVolumeView.exe")).toThrow(TypeError);
  });
});

describe("AudioRouteManager", () => {
  it("refuses to construct with an unexpected SoundVolumeView path", () => {
    expect(
      () => new AudioRouteManager({ svvPath: "calc.exe", userDataDir: "/tmp", logger: console })
    ).toThrow(TypeError);
  });
});
