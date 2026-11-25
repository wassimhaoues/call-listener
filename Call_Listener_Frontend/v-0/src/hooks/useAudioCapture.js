import { useCallback, useEffect, useRef, useState } from "react";
import {
  CAPTURE_SAMPLE_RATE,
  floatToPcm16,
  microphoneConstraints,
  rmsToLevel,
  SILENT_LEVEL,
  systemAudioConstraints,
} from "@/services/audioCapture.js";

export const PCM_WORKLET_URL = new URL("../worklets/pcm-processor.js", import.meta.url);
const SCRIPT_PROCESSOR_FRAME = 4096;

// Captures the candidate microphone and, when enabled, the interviewer
// (system) device. Emits PCM16 48 kHz mono chunks through `onChunk(source,
// buffer)` and exposes live levels for the meters. Pausing is enforced by the
// chunk consumer, so capture and meters keep running while paused.
export function useAudioCapture({ onChunk, workletUrl = PCM_WORKLET_URL }) {
  const [levels, setLevels] = useState({ mic: SILENT_LEVEL, system: SILENT_LEVEL });

  const onChunkRef = useRef(onChunk);
  onChunkRef.current = onChunk;
  const ctxRef = useRef(null);
  const keepRef = useRef(null);
  const micStreamRef = useRef(null);
  const sysStreamRef = useRef(null);
  const micNodeRef = useRef(null);
  const sysNodeRef = useRef(null);

  const reportLevel = useCallback((source, rms) => {
    const level = rmsToLevel(rms);
    setLevels((current) =>
      source === "mic" ? { ...current, mic: level } : { ...current, system: level }
    );
  }, []);

  const start = useCallback(
    async ({ micId, sysId, systemAudioEnabled }) => {
      const ctx = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: CAPTURE_SAMPLE_RATE,
        latencyHint: "interactive",
      });
      ctxRef.current = ctx;

      const micStream = await navigator.mediaDevices.getUserMedia(
        microphoneConstraints(micId)
      );
      let sysStream = null;
      if (systemAudioEnabled) {
        sysStream = await navigator.mediaDevices.getUserMedia(
          systemAudioConstraints(sysId)
        );
      }
      micStreamRef.current = micStream;
      sysStreamRef.current = sysStream;

      const micSrc = ctx.createMediaStreamSource(micStream);
      const sysSrc = sysStream ? ctx.createMediaStreamSource(sysStream) : null;

      // A muted sink keeps the graph pulling audio without audible playback.
      const keep = ctx.createGain();
      keep.gain.value = 0;
      keep.connect(ctx.destination);
      keepRef.current = keep;

      try {
        await ctx.audioWorklet.addModule(workletUrl);
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

        const onPort = (ev) => {
          const { type, source, rms, buffer } = ev.data || {};
          if (type === "meter") {
            reportLevel(source, rms);
          } else if (type === "chunk" && buffer) {
            onChunkRef.current?.(source, buffer);
          }
        };
        micNode.port.onmessage = onPort;
        if (sysNode) sysNode.port.onmessage = onPort;

        micSrc.connect(micNode);
        micSrc.connect(keep);
        if (sysSrc && sysNode) {
          sysSrc.connect(sysNode);
          sysSrc.connect(keep);
        }

        micNodeRef.current = micNode;
        sysNodeRef.current = sysNode;
      } catch (err) {
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
    },
    [reportLevel, workletUrl]
  );

  // Asks each worklet to emit its partially filled batch.
  const flush = useCallback(() => {
    try {
      micNodeRef.current?.port?.postMessage({ type: "flush" });
      sysNodeRef.current?.port?.postMessage({ type: "flush" });
    } catch {}
  }, []);

  // Releases media tracks, detaches processing handlers, and closes the
  // AudioContext. Idempotent: later calls find nothing left to release.
  const stop = useCallback(() => {
    try {
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
    } catch {}
    try {
      sysStreamRef.current?.getTracks().forEach((t) => t.stop());
    } catch {}
    try {
      const micNode = micNodeRef.current;
      const sysNode = sysNodeRef.current;
      if (micNode?.port) micNode.port.onmessage = null;
      if (sysNode?.port) sysNode.port.onmessage = null;
      if (micNode?.onaudioprocess) micNode.onaudioprocess = null;
      if (sysNode?.onaudioprocess) sysNode.onaudioprocess = null;
    } catch {}
    try {
      ctxRef.current?.close();
    } catch {}
    micStreamRef.current = null;
    sysStreamRef.current = null;
    micNodeRef.current = null;
    sysNodeRef.current = null;
    keepRef.current = null;
    ctxRef.current = null;
  }, []);

  useEffect(
    () => () => {
      flush();
      stop();
    },
    [flush, stop]
  );

  return { levels, start, flush, stop };
}
