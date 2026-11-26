import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAudioCapture } from "../src/hooks/useAudioCapture.js";
import { installFakeAudio } from "./helpers/fakes.js";

let audio;

beforeEach(() => {
  audio = installFakeAudio();
});

afterEach(() => {
  audio.restore();
  vi.restoreAllMocks();
});

function setup() {
  const onChunk = vi.fn();
  const hook = renderHook(() =>
    useAudioCapture({ onChunk, workletUrl: "pcm-processor.js" })
  );
  return { onChunk, ...hook };
}

const DEVICES = { micId: "mic-1", sysId: "sys-1", systemAudioEnabled: true };

describe("useAudioCapture", () => {
  it("captures mic and system devices through labelled PCM worklets", async () => {
    const { result } = setup();
    await act(() => result.current.start(DEVICES));

    const [ctx] = audio.contexts;
    expect(ctx.options).toEqual({ sampleRate: 48000, latencyHint: "interactive" });
    expect(audio.getUserMedia).toHaveBeenCalledTimes(2);
    expect(audio.getUserMedia.mock.calls[0][0].audio.deviceId).toEqual({ exact: "mic-1" });
    expect(audio.getUserMedia.mock.calls[1][0].audio.deviceId).toEqual({ exact: "sys-1" });
    expect(ctx.audioWorklet.addModule).toHaveBeenCalledWith("pcm-processor.js");
    expect(audio.workletNodes.map((node) => node.options.processorOptions.source)).toEqual([
      "mic",
      "system",
    ]);
    expect(ctx.resume).toHaveBeenCalled();
  });

  it("captures only the microphone in microphone-only mode", async () => {
    const { result } = setup();
    await act(() =>
      result.current.start({ micId: "mic-1", sysId: null, systemAudioEnabled: false })
    );
    expect(audio.getUserMedia).toHaveBeenCalledTimes(1);
    expect(audio.workletNodes).toHaveLength(1);
  });

  it("forwards chunks and updates meters from worklet messages", async () => {
    const { result, onChunk } = setup();
    await act(() => result.current.start(DEVICES));
    const [micNode, sysNode] = audio.workletNodes;
    const buffer = new Int16Array([1]).buffer;

    act(() => micNode.port.onmessage({ data: { type: "chunk", source: "mic", buffer } }));
    act(() => sysNode.port.onmessage({ data: { type: "meter", source: "system", rms: 0.1 } }));

    expect(onChunk).toHaveBeenCalledWith("mic", buffer);
    expect(result.current.levels.system).toEqual({ db: "-20.0 dB", pct: (40 / 60) * 100 });
    expect(result.current.levels.mic).toEqual({ db: "–∞ dB", pct: 0 });
  });

  it("flushes worklets, then stop releases tracks and closes the context once", async () => {
    const { result } = setup();
    await act(() => result.current.start(DEVICES));
    const [ctx] = audio.contexts;
    const [micNode, sysNode] = audio.workletNodes;

    act(() => result.current.flush());
    expect(micNode.port.postMessage).toHaveBeenCalledWith({ type: "flush" });
    expect(sysNode.port.postMessage).toHaveBeenCalledWith({ type: "flush" });

    act(() => result.current.stop());
    act(() => result.current.stop());

    for (const stream of audio.streams) {
      expect(stream.tracks[0].stop).toHaveBeenCalledTimes(1);
    }
    expect(micNode.port.onmessage).toBeNull();
    expect(sysNode.port.onmessage).toBeNull();
    expect(ctx.close).toHaveBeenCalledTimes(1);
  });

  it("flushes and releases capture on unmount", async () => {
    const { result, unmount } = setup();
    await act(() => result.current.start(DEVICES));
    unmount();
    expect(audio.workletNodes[0].port.postMessage).toHaveBeenCalledWith({ type: "flush" });
    expect(audio.streams[0].tracks[0].stop).toHaveBeenCalled();
    expect(audio.contexts[0].close).toHaveBeenCalled();
  });

  it("falls back to ScriptProcessor PCM16 when the worklet cannot load", async () => {
    audio.restore();
    audio = installFakeAudio({ workletFails: true });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result, onChunk } = setup();
    await act(() => result.current.start(DEVICES));

    expect(audio.scriptProcessors).toHaveLength(2);
    const [micProc] = audio.scriptProcessors;
    act(() =>
      micProc.onaudioprocess({
        inputBuffer: { getChannelData: () => new Float32Array([0.5, -0.5]) },
      })
    );
    const [source, buffer] = onChunk.mock.calls[0];
    expect(source).toBe("mic");
    expect(Array.from(new Int16Array(buffer))).toEqual([16383, -16383]);
    expect(result.current.levels.mic.db).toBe("-6.0 dB");

    act(() => result.current.stop());
    expect(micProc.onaudioprocess).toBeNull();
  });
});
