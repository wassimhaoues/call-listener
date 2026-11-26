import { useCallback, useEffect, useRef, useState } from "react";
import {
  CAPTURE_SAMPLE_RATE,
  CaptureError,
  floatToPcm16,
  microphoneConstraints,
  rmsToLevel,
  SILENT_LEVEL,
  systemAudioConstraints,
} from "@/services/audioCapture.js";

export const PCM_WORKLET_URL = new URL("../worklets/pcm-processor.js", import.meta.url);
// Upper bound on how long Stop waits for the worklets' final partial batch.
export const FLUSH_TIMEOUT_MS = 250;
const SCRIPT_PROCESSOR_FRAME = 4096;

function stopTracks(stream) {
  try {
    stream?.getTracks().forEach((track) => track.stop());
  } catch {}
}

function closeContext(ctx) {
  if (!ctx) return;
  try {
    Promise.resolve(ctx.close()).catch(() => {});
  } catch {}
}

// Captures the candidate microphone and, when enabled, the interviewer
// (system) device. Emits PCM16 48 kHz mono chunks through `onChunk(source,
// buffer)` and exposes live levels for the meters. Pausing is enforced by the
// chunk consumer, so capture and meters keep running while paused.
//
// start() resolves true once capturing, false when stop()/unmount cancelled
// it (anything acquired late is released), and rejects with a CaptureError
// naming the failing source when getUserMedia fails (after releasing
// everything it acquired).
//
// If the interviewer (system) device disappears mid-interview (its track
// ends, e.g. a PipeWire monitor source removed with its output device), only
// that source is released and `onSourceLost("system")` is called once. The
// microphone keeps capturing; nothing is synthesised for the lost source.
export function useAudioCapture({
  onChunk,
  onSourceLost,
  workletUrl = PCM_WORKLET_URL,
  flushTimeoutMs = FLUSH_TIMEOUT_MS,
}) {
  const [levels, setLevels] = useState({ mic: SILENT_LEVEL, system: SILENT_LEVEL });

  const onChunkRef = useRef(onChunk);
  onChunkRef.current = onChunk;
  const onSourceLostRef = useRef(onSourceLost);
  onSourceLostRef.current = onSourceLost;
  // Bumped by stop(); a start() still awaiting devices sees it and backs out.
  const sessionRef = useRef(0);
  const ctxRef = useRef(null);
  const keepRef = useRef(null);
  const micStreamRef = useRef(null);
  const sysStreamRef = useRef(null);
  const micNodeRef = useRef(null);
  const sysNodeRef = useRef(null);
  const sysSrcRef = useRef(null);
  // Detaches the system track "ended" listener of the current session.
  const sysEndedCleanupRef = useRef(null);
  // Worklet node -> callbacks waiting for its "flushed" acknowledgement.
  const flushWaitersRef = useRef(new Map());

  const reportLevel = useCallback((source, rms) => {
    const level = rmsToLevel(rms);
    setLevels((current) =>
      source === "mic" ? { ...current, mic: level } : { ...current, system: level }
    );
  }, []);

  // Runs the flush callbacks waiting on `node`, or on every node.
  const settleFlushWaiters = useCallback((node) => {
    const waiters = flushWaitersRef.current;
    const nodes = node ? [node] : [...waiters.keys()];
    for (const key of nodes) {
      const callbacks = waiters.get(key);
      waiters.delete(key);
      callbacks?.forEach((callback) => callback());
    }
  }, []);

  // Releases media tracks, detaches processing handlers, and closes the
  // AudioContext. Idempotent: later calls find nothing left to release.
  const stop = useCallback(() => {
    sessionRef.current += 1;
    sysEndedCleanupRef.current?.();
    sysEndedCleanupRef.current = null;
    stopTracks(micStreamRef.current);
    stopTracks(sysStreamRef.current);
    try {
      const micNode = micNodeRef.current;
      const sysNode = sysNodeRef.current;
      if (micNode?.port) micNode.port.onmessage = null;
      if (sysNode?.port) sysNode.port.onmessage = null;
      if (micNode?.onaudioprocess) micNode.onaudioprocess = null;
      if (sysNode?.onaudioprocess) sysNode.onaudioprocess = null;
    } catch {}
    closeContext(ctxRef.current);
    settleFlushWaiters();
    micStreamRef.current = null;
    sysStreamRef.current = null;
    micNodeRef.current = null;
    sysNodeRef.current = null;
    sysSrcRef.current = null;
    keepRef.current = null;
    ctxRef.current = null;
  }, [settleFlushWaiters]);

  // Releases only the interviewer (system) source after its device was lost:
  // stops its tracks, disconnects its graph branch, and silences its meter.
  const releaseSystemSource = useCallback(() => {
    sysEndedCleanupRef.current?.();
    sysEndedCleanupRef.current = null;
    const node = sysNodeRef.current;
    stopTracks(sysStreamRef.current);
    try {
      sysSrcRef.current?.disconnect?.();
      if (node?.port) node.port.onmessage = null;
      if (node?.onaudioprocess) node.onaudioprocess = null;
      node?.disconnect?.();
    } catch {}
    if (node) settleFlushWaiters(node);
    sysStreamRef.current = null;
    sysSrcRef.current = null;
    sysNodeRef.current = null;
    setLevels((current) => ({ ...current, system: SILENT_LEVEL }));
  }, [settleFlushWaiters]);

  // Watches the system tracks for an "ended" event (device removed or
  // revoked). track.stop() does not fire "ended", so stop() never triggers it.
  const watchSystemTracks = useCallback(
    (stream, session) => {
      const tracks = stream?.getTracks?.() || [];
      const onEnded = () => {
        if (session !== sessionRef.current || !sysStreamRef.current) return;
        releaseSystemSource();
        onSourceLostRef.current?.("system");
      };
      tracks.forEach((track) => track.addEventListener?.("ended", onEnded));
      sysEndedCleanupRef.current = () =>
        tracks.forEach((track) => track.removeEventListener?.("ended", onEnded));
      return tracks.length > 0 && tracks.every((track) => track.readyState === "ended");
    },
    [releaseSystemSource]
  );

  const start = useCallback(
    async ({ micId, sysId, systemAudioEnabled }) => {
      const session = sessionRef.current;
      const cancelled = () => session !== sessionRef.current;

      const ctx = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: CAPTURE_SAMPLE_RATE,
        latencyHint: "interactive",
      });
      ctxRef.current = ctx;

      // Resolves null (after releasing the stream) when stop() won the race.
      const acquire = async (source, constraints, ref) => {
        let stream;
        try {
          stream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch (err) {
          throw new CaptureError(source, err);
        }
        if (cancelled()) {
          stopTracks(stream);
          return null;
        }
        ref.current = stream;
        return stream;
      };

      let micStream;
      let sysStream = null;
      try {
        micStream = await acquire("mic", microphoneConstraints(micId), micStreamRef);
        if (!micStream) return false;
        if (systemAudioEnabled) {
          sysStream = await acquire("system", systemAudioConstraints(sysId), sysStreamRef);
          if (!sysStream) return false;
        }
      } catch (err) {
        if (cancelled()) return false;
        stop();
        throw err;
      }

      const micSrc = ctx.createMediaStreamSource(micStream);
      const sysSrc = sysStream ? ctx.createMediaStreamSource(sysStream) : null;
      sysSrcRef.current = sysSrc;

      // A muted sink keeps the graph pulling audio without audible playback.
      const keep = ctx.createGain();
      keep.gain.value = 0;
      keep.connect(ctx.destination);
      keepRef.current = keep;

      try {
        await ctx.audioWorklet.addModule(workletUrl);
        if (cancelled()) return false;
        const micNode = new AudioWorkletNode(ctx, "pcm-worklet", {
          numberOfInputs: 1,
          numberOfOutputs: 0,
          processorOptions: { source: "mic" },
        });
        const sysNode = sysSrc
          ? new AudioWorkletNode(ctx, "pcm-worklet", {
            numberOfInputs: 1,
            numberOfOutputs: 0,
            processorOptions: { source: "system" },
          })
          : null;

        const listen = (node) => (ev) => {
          const { type, source, rms, buffer } = ev.data || {};
          if (type === "meter") {
            reportLevel(source, rms);
          } else if (type === "chunk" && buffer) {
            onChunkRef.current?.(source, buffer);
          } else if (type === "flushed") {
            settleFlushWaiters(node);
          }
        };
        micNode.port.onmessage = listen(micNode);
        if (sysNode) sysNode.port.onmessage = listen(sysNode);

        micSrc.connect(micNode);
        micSrc.connect(keep);
        if (sysSrc && sysNode) {
          sysSrc.connect(sysNode);
          sysSrc.connect(keep);
        }

        micNodeRef.current = micNode;
        sysNodeRef.current = sysNode;
      } catch (err) {
        if (cancelled()) return false;
        // Fallback for runtimes where the AudioWorklet cannot load.
        const micProc = ctx.createScriptProcessor(SCRIPT_PROCESSOR_FRAME, 1, 1);
        const sysProc = sysSrc
          ? ctx.createScriptProcessor(SCRIPT_PROCESSOR_FRAME, 1, 1)
          : null;

        const handle = (e, source) => {
          const { pcm, rms } = floatToPcm16(e.inputBuffer.getChannelData(0));
          reportLevel(source, rms);
          onChunkRef.current?.(source, pcm.buffer);
        };

        micProc.onaudioprocess = (e) => handle(e, "mic");
        if (sysProc) sysProc.onaudioprocess = (e) => handle(e, "system");
        micSrc.connect(micProc).connect(keep);
        if (sysSrc && sysProc) sysSrc.connect(sysProc).connect(keep);

        micNodeRef.current = micProc;
        sysNodeRef.current = sysProc;
        console.warn(
          "[audio] Worklet failed; using ScriptProcessor fallback:",
          err?.message
        );
      }

      if (ctx.state === "suspended") {
        try {
          await ctx.resume();
        } catch {}
      }
      if (cancelled()) return false;
      // A device removed while the graph was being built has already ended.
      if (sysStream && watchSystemTracks(sysStream, session)) {
        releaseSystemSource();
        onSourceLostRef.current?.("system");
      }
      return true;
    },
    [releaseSystemSource, reportLevel, settleFlushWaiters, stop, watchSystemTracks, workletUrl]
  );

  // Asks each worklet to emit its partially filled batch and resolves once
  // every worklet has acknowledged (its final chunk reaches onChunk first), or
  // after flushTimeoutMs. Never rejects. The ScriptProcessor fallback holds no
  // partial batch, so it resolves immediately.
  const flush = useCallback(() => {
    const nodes = [micNodeRef.current, sysNodeRef.current].filter((node) => node?.port);
    if (nodes.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      let remaining = nodes.length;
      const timer = setTimeout(resolve, flushTimeoutMs);
      const acknowledge = () => {
        remaining -= 1;
        if (remaining === 0) {
          clearTimeout(timer);
          resolve();
        }
      };
      const waiters = flushWaitersRef.current;
      for (const node of nodes) {
        if (!waiters.has(node)) waiters.set(node, []);
        waiters.get(node).push(acknowledge);
        try {
          node.port.postMessage({ type: "flush" });
        } catch {
          settleFlushWaiters(node);
        }
      }
    });
  }, [flushTimeoutMs, settleFlushWaiters]);

  useEffect(
    () => () => {
      flush();
      stop();
    },
    [flush, stop]
  );

  return { levels, start, flush, stop };
}
