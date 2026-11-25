import { describe, expect, it } from "vitest";
import capabilities from "../services/platformCapabilities.js";

const { getPlatformCapabilities } = capabilities;

describe("getPlatformCapabilities", () => {
  it("keeps the established Windows VB-Cable route", () => {
    expect(getPlatformCapabilities({ platform: "win32" })).toEqual({
      appSupported: true,
      systemAudio: {
        supported: true,
        strategy: "vb-cable",
        requiresCandidateConsent: false,
      },
    });
  });

  it("enables Linux desktop audio only when PipeWire and a display server exist", () => {
    expect(
      getPlatformCapabilities({
        platform: "linux",
        hasPipeWire: true,
        hasDisplayServer: true,
      })
    ).toEqual({
      appSupported: true,
      systemAudio: {
        supported: true,
        strategy: "pipewire-desktop",
        fallback: "monitor-source",
        requiresCandidateConsent: true,
      },
    });
  });

  it("keeps Linux usable when system audio is unavailable", () => {
    const result = getPlatformCapabilities({ platform: "linux" });

    expect(result.appSupported).toBe(true);
    expect(result.systemAudio).toMatchObject({
      supported: false,
      strategy: "unavailable",
      fallback: "monitor-source",
    });
  });

  it("reports unsupported operating systems without a platform-specific fallback", () => {
    expect(getPlatformCapabilities({ platform: "darwin" })).toEqual({
      appSupported: false,
      systemAudio: { supported: false, strategy: "unavailable" },
    });
  });
});
