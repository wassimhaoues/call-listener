import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAudioCapture } from "../src/hooks/useAudioCapture.js";
import { createFakeStream, installFakeAudio } from "./helpers/fakes.js";

let audio;

beforeEach(() => {
  audio = installFakeAudio();
});

afterEach(() => {
  audio.restore();
  vi.restoreAllMocks();
});

function setup(options = {}) {
  const onChunk = vi.fn();
  const hook = renderHook(() =>
    useAudioCapture({ onChunk, workletUrl: "pcm-processor.js", ...options })
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

    let flushed;
    act(() => {
      flushed = result.current.flush();
    });
    expect(micNode.port.postMessage).toHaveBeenCalledWith({ type: "flush" });
    expect(sysNode.port.postMessage).toHaveBeenCalledWith({ type: "flush" });
    act(() => micNode.port.onmessage({ data: { type: "flushed" } }));
    act(() => sysNode.port.onmessage({ data: { type: "flushed" } }));
    await act(() => flushed);

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

  it("flush resolves once every worklet delivered its final batch", async () => {
    const { result, onChunk } = setup();
    await act(() => result.current.start(DEVICES));
    const [micNode, sysNode] = audio.workletNodes;
    const buffer = new Int16Array([7]).buffer;

    let done = false;
    let flushed;
    act(() => {
      flushed = result.current.flush().then(() => (done = true));
    });
    act(() => micNode.port.onmessage({ data: { type: "chunk", source: "mic", buffer } }));
    act(() => micNode.port.onmessage({ data: { type: "flushed" } }));
    await act(async () => {});
    expect(done).toBe(false); // still waiting for the system worklet

    act(() => sysNode.port.onmessage({ data: { type: "flushed" } }));
    await act(() => flushed);
    expect(done).toBe(true);
    expect(onChunk).toHaveBeenCalledWith("mic", buffer);
  });

  it("bounds the flush wait when a worklet never answers", async () => {
    const { result } = setup({ flushTimeoutMs: 20 });
    await act(() => result.current.start(DEVICES));
    const started = Date.now();
    await act(() => result.current.flush());
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("flush resolves immediately when nothing is capturing", async () => {
    const { result } = setup();
    await act(() => result.current.flush());
  });

  it("releases a stream that arrives after stop", async () => {
    let resolveMic;
    audio.getUserMedia.mockImplementationOnce(
      () => new Promise((resolve) => (resolveMic = resolve))
    );
    const { result } = setup();
    let pending;
    act(() => {
      pending = result.current.start({ micId: "mic-1", systemAudioEnabled: false });
    });
    act(() => result.current.stop());

    const lateStream = { tracks: [{ stop: vi.fn() }] };
    lateStream.getTracks = () => lateStream.tracks;
    let started;
    await act(async () => {
      resolveMic(lateStream);
      started = await pending;
    });

    expect(started).toBe(false);
    expect(lateStream.tracks[0].stop).toHaveBeenCalledTimes(1);
    expect(audio.contexts[0].close).toHaveBeenCalled();
    expect(audio.workletNodes).toHaveLength(0);
  });

  it("releases capture when the hook unmounts during getUserMedia", async () => {
    let resolveMic;
    audio.getUserMedia.mockImplementationOnce(
      () => new Promise((resolve) => (resolveMic = resolve))
    );
    const { result, unmount } = setup();
    let pending;
    act(() => {
      pending = result.current.start({ micId: "mic-1", systemAudioEnabled: false });
    });
    unmount();
    const lateStream = { tracks: [{ stop: vi.fn() }] };
    lateStream.getTracks = () => lateStream.tracks;
    await act(async () => {
      resolveMic(lateStream);
      await pending;
    });
    expect(lateStream.tracks[0].stop).toHaveBeenCalledTimes(1);
  });

  it("rejects with the failing source and releases what was acquired", async () => {
    const denied = Object.assign(new Error("denied"), { name: "NotFoundError" });
    audio.getUserMedia
      .mockImplementationOnce(async () => {
        const stream = { tracks: [{ stop: vi.fn() }] };
        stream.getTracks = () => stream.tracks;
        audio.streams.push(stream);
        return stream;
      })
      .mockImplementationOnce(async () => {
        throw denied;
      });
    const { result } = setup();

    let error;
    await act(async () => {
      try {
        await result.current.start(DEVICES);
      } catch (err) {
        error = err;
      }
    });

    expect(error).toMatchObject({ name: "NotFoundError", source: "system" });
    expect(error.cause).toBe(denied);
    expect(audio.streams[0].tracks[0].stop).toHaveBeenCalledTimes(1);
    expect(audio.contexts[0].close).toHaveBeenCalledTimes(1);
  });

  describe("interviewer (system) device loss", () => {
    it("releases only the system source, keeps the mic, and reports it once", async () => {
      const onSourceLost = vi.fn();
      const { result, onChunk } = setup({ onSourceLost });
      await act(() => result.current.start(DEVICES));
      const [micStream, sysStream] = audio.streams;
      const [micNode, sysNode] = audio.workletNodes;
      const [ctx] = audio.contexts;
      act(() => sysNode.port.onmessage({ data: { type: "meter", source: "system", rms: 0.1 } }));

      act(() => sysStream.tracks[0].end());

      expect(onSourceLost).toHaveBeenCalledTimes(1);
      expect(onSourceLost).toHaveBeenCalledWith("system");
      expect(sysStream.tracks[0].stop).toHaveBeenCalledTimes(1);
      expect(sysNode.port.onmessage).toBeNull();
      expect(ctx.sources[1].disconnect).toHaveBeenCalled();
      expect(result.current.levels.system).toEqual({ db: "–∞ dB", pct: 0 });
      // The microphone is untouched and still delivers candidate audio.
      expect(micStream.tracks[0].stop).not.toHaveBeenCalled();
      expect(ctx.close).not.toHaveBeenCalled();
      const buffer = new Int16Array([3]).buffer;
      act(() => micNode.port.onmessage({ data: { type: "chunk", source: "mic", buffer } }));
      expect(onChunk).toHaveBeenCalledWith("mic", buffer);
      expect(onChunk.mock.calls.every(([source]) => source === "mic")).toBe(true);

      // A repeated "ended" and the later flush do not resurrect the source.
      act(() => sysStream.tracks[0].end());
      expect(onSourceLost).toHaveBeenCalledTimes(1);
      let flushed;
      act(() => {
        flushed = result.current.flush();
      });
      expect(sysNode.port.postMessage).not.toHaveBeenCalled();
      act(() => micNode.port.onmessage({ data: { type: "flushed" } }));
      await act(() => flushed);

      act(() => result.current.stop());
      expect(micStream.tracks[0].stop).toHaveBeenCalledTimes(1);
      expect(sysStream.tracks[0].stop).toHaveBeenCalledTimes(1);
    });

    it("reports a system device that ended before capture finished starting", async () => {
      const onSourceLost = vi.fn();
      audio.getUserMedia
        .mockImplementationOnce(async () => {
          const stream = createFakeStream();
          audio.streams.push(stream);
          return stream;
        })
        .mockImplementationOnce(async () => {
          const stream = createFakeStream();
          stream.tracks[0].readyState = "ended";
          audio.streams.push(stream);
          return stream;
        });
      const { result } = setup({ onSourceLost });
      let started;
      await act(async () => {
        started = await result.current.start(DEVICES);
      });
      expect(started).toBe(true);
      expect(onSourceLost).toHaveBeenCalledWith("system");
      expect(audio.streams[1].tracks[0].stop).toHaveBeenCalled();
      expect(audio.streams[0].tracks[0].stop).not.toHaveBeenCalled();
    });

    it("does not report loss for tracks ended by stop()", async () => {
      const onSourceLost = vi.fn();
      const { result } = setup({ onSourceLost });
      await act(() => result.current.start(DEVICES));
      const sysTrack = audio.streams[1].tracks[0];
      act(() => result.current.stop());
      expect(sysTrack.removeEventListener).toHaveBeenCalledWith("ended", expect.any(Function));
      act(() => sysTrack.end());
      expect(onSourceLost).not.toHaveBeenCalled();
    });

    it("ignores mic-only sessions", async () => {
      const onSourceLost = vi.fn();
      const { result } = setup({ onSourceLost });
      await act(() =>
        result.current.start({ micId: "mic-1", sysId: null, systemAudioEnabled: false })
      );
      act(() => audio.streams[0].tracks[0].end());
      expect(onSourceLost).not.toHaveBeenCalled();
    });
  });
});
