import { describe, expect, it } from "vitest";
import {
  hasDeviceLabels,
  isMonitorSource,
  isMonitorSourceLabel,
  partitionAudioInputs,
} from "../src/services/monitorSources.js";

const input = (deviceId, label) => ({ kind: "audioinput", deviceId, label });

describe("isMonitorSourceLabel", () => {
  it.each([
    "Monitor of Built-in Audio Analog Stereo",
    "monitor of HDMI / DisplayPort 2 Output",
    "  Monitor of USB Headset  ",
    "alsa_output.pci-0000_00_1f.3.analog-stereo.monitor",
    "bluez_output.AA_BB.1.monitor",
    "Default - Monitor of Built-in Audio Analog Stereo",
    "Remapped Monitor of Built-in Audio Analog Stereo",
  ])("recognises %s", (label) => {
    expect(isMonitorSourceLabel(label)).toBe(true);
  });

  it.each([
    "",
    "Built-in Audio Analog Stereo",
    "Default",
    "Studio Monitor Headphones Mic",
    "Monitor of",
    "alsa_input.pci-0000_00_1f.3.analog-stereo",
    // Translated descriptions are a documented limitation, not a match.
    "Monitor von Interne Audio Analog Stereo",
    undefined,
    null,
    42,
  ])("does not treat %s as a monitor", (label) => {
    expect(isMonitorSourceLabel(label)).toBe(false);
  });
});

describe("isMonitorSource", () => {
  it("requires an audio input with a concrete device ID", () => {
    expect(isMonitorSource(input("m1", "Monitor of Speakers"))).toBe(true);
    expect(isMonitorSource({ kind: "audiooutput", deviceId: "o1", label: "Monitor of Speakers" })).toBe(false);
    expect(isMonitorSource(input("", "Monitor of Speakers"))).toBe(false);
    expect(isMonitorSource(input("default", "Default - Monitor of Speakers"))).toBe(false);
    expect(isMonitorSource(input("communications", "Monitor of Speakers"))).toBe(false);
    expect(isMonitorSource(null)).toBe(false);
  });
});

describe("hasDeviceLabels", () => {
  it("is false before media permission exposes labels", () => {
    expect(hasDeviceLabels([input("a", ""), input("b", "")])).toBe(false);
    expect(hasDeviceLabels([])).toBe(false);
    expect(hasDeviceLabels(undefined)).toBe(false);
    expect(hasDeviceLabels([{ kind: "audiooutput", deviceId: "o", label: "Speakers" }])).toBe(false);
  });

  it("is true once any audio input has a label", () => {
    expect(hasDeviceLabels([input("a", ""), input("b", "Headset")])).toBe(true);
  });
});

describe("partitionAudioInputs", () => {
  it("never offers a monitor as a microphone", () => {
    const devices = [
      input("default", "Default - Monitor of Speakers"),
      input("mic-1", "Built-in Audio Analog Stereo"),
      input("mon-1", "Monitor of Built-in Audio Analog Stereo"),
      input("mon-2", "alsa_output.usb-headset.monitor"),
      { kind: "audiooutput", deviceId: "out-1", label: "Speakers" },
      { kind: "videoinput", deviceId: "cam-1", label: "Camera" },
    ];
    const { microphones, monitors } = partitionAudioInputs(devices);
    expect(microphones.map((d) => d.deviceId)).toEqual(["mic-1"]);
    expect(monitors.map((d) => d.deviceId)).toEqual(["mon-1", "mon-2"]);
  });

  it("keeps unlabeled inputs as microphones and finds no monitors", () => {
    const { microphones, monitors } = partitionAudioInputs([input("a", ""), input("b", "")]);
    expect(microphones).toHaveLength(2);
    expect(monitors).toEqual([]);
  });

  it("tolerates missing input", () => {
    expect(partitionAudioInputs(undefined)).toEqual({ microphones: [], monitors: [] });
  });
});
