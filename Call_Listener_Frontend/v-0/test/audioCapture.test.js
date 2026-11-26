import { describe, expect, it } from "vitest";
import {
  CaptureError,
  dbToPct,
  describeCaptureError,
  floatToPcm16,
  getDeviceSelectionError,
  microphoneConstraints,
  rmsToDb,
  rmsToLevel,
  systemAudioConstraints,
} from "../src/services/audioCapture.js";
import {
  bytesToBase64,
  encodeAudioMessage,
  encodeContextMessage,
  encodeEndMessage,
  encodeInterviewerQuestionMessage,
} from "../src/services/interviewMessages.js";

describe("getDeviceSelectionError", () => {
  it("requires a microphone, and a distinct system device when enabled", () => {
    expect(getDeviceSelectionError({ micId: null, systemAudioEnabled: false })).toBe(
      "Missing device selections."
    );
    expect(getDeviceSelectionError({ micId: "m", sysId: null, systemAudioEnabled: true })).toBe(
      "Missing device selections."
    );
    expect(getDeviceSelectionError({ micId: "m", sysId: "m", systemAudioEnabled: true })).toBe(
      "Microphone and system audio devices must be different."
    );
    expect(getDeviceSelectionError({ micId: "m", sysId: "s", systemAudioEnabled: true })).toBeNull();
    expect(getDeviceSelectionError({ micId: "m", sysId: null, systemAudioEnabled: false })).toBeNull();
  });
});

describe("capture constraints", () => {
  it("processes the microphone but leaves system loopback untouched", () => {
    expect(microphoneConstraints("mic-1").audio).toMatchObject({
      deviceId: { exact: "mic-1" },
      channelCount: 1,
      sampleRate: 48000,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
    expect(systemAudioConstraints("sys-1").audio).toMatchObject({
      deviceId: { exact: "sys-1" },
      channelCount: 1,
      sampleRate: 48000,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
  });
});

describe("levels", () => {
  it("maps silence to the floor and clamps to a 0–100 meter", () => {
    expect(rmsToDb(0)).toBe(-Infinity);
    expect(rmsToDb(1e-8)).toBe(-Infinity);
    expect(dbToPct(-Infinity)).toBe(0);
    expect(dbToPct(-90)).toBe(0);
    expect(dbToPct(-30)).toBe(50);
    expect(dbToPct(6)).toBe(100);
    expect(rmsToLevel(0)).toEqual({ db: "–∞ dB", pct: 0 });
    expect(rmsToLevel(0.1)).toEqual({ db: "-20.0 dB", pct: (40 / 60) * 100 });
  });
});

describe("floatToPcm16", () => {
  it("clamps and scales samples like the worklet", () => {
    const { pcm, rms } = floatToPcm16(new Float32Array([0, 0.5, -0.5, 2, -2]));
    expect(Array.from(pcm)).toEqual([0, 16383, -16383, 32767, -32767]);
    expect(rms).toBeCloseTo(Math.sqrt((0.25 + 0.25 + 1 + 1) / 5));
  });
});

describe("interview message encoders", () => {
  it("encodes the documented client message shapes", () => {
    expect(JSON.parse(encodeContextMessage({ version: 1 }))).toEqual({
      context: { version: 1 },
    });
    expect(JSON.parse(encodeInterviewerQuestionMessage("Why?"))).toEqual({
      interviewer_question: "Why?",
    });
    expect(JSON.parse(encodeEndMessage())).toEqual({ end: true });
  });

  it("base64-encodes PCM16 audio chunks with their source label", () => {
    const pcm = new Int16Array([1, -1]);
    expect(JSON.parse(encodeAudioMessage("mic", pcm.buffer))).toEqual({
      source: "mic",
      chunk: Buffer.from(pcm.buffer).toString("base64"),
    });
  });

  it("encodes buffers larger than one String.fromCharCode batch", () => {
    const bytes = new Uint8Array(0x8000 * 2 + 7).map((_, i) => i % 256);
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });
});

describe("describeCaptureError", () => {
  const domError = (name) => Object.assign(new Error("x"), { name });

  it("explains a denied microphone permission", () => {
    const message = describeCaptureError(new CaptureError("mic", domError("NotAllowedError")));
    expect(message).toMatch(/Microphone access was denied/);
    expect(describeCaptureError(new CaptureError("mic", domError("SecurityError")))).toBe(message);
  });

  it("names the missing device", () => {
    expect(describeCaptureError(new CaptureError("mic", domError("NotFoundError")))).toMatch(
      /selected microphone was not found/
    );
    expect(
      describeCaptureError(new CaptureError("system", domError("OverconstrainedError")))
    ).toMatch(/selected interviewer \(system\) audio device was not found/);
  });

  it("reports a busy device and falls back to a generic message", () => {
    expect(describeCaptureError(new CaptureError("mic", domError("NotReadableError")))).toMatch(
      /in use by another application/
    );
    const generic = describeCaptureError(new CaptureError("system", domError("AbortError")));
    expect(generic).toMatch(/Could not start interviewer \(system\) audio capture \(AbortError\)/);
    expect(describeCaptureError(undefined)).toMatch(/Could not start microphone capture/);
  });
});
