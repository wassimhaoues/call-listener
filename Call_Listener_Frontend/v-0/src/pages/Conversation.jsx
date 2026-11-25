// FILE: src/pages/Conversation.jsx
import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useUI } from "@/ui/UIContext.jsx";
import Button from "@/components/ui/Button.jsx";
import { Card, CardBody, CardHeader } from "@/components/ui/Card.jsx";
import Meter from "@/components/Meter.jsx";
import StatusBar from "@/components/StatusBar.jsx";
import LiveGuidancePanel from "@/components/LiveGuidancePanel.jsx";
import { shouldSendAudio } from "@/services/audioBackpressure.js";

const AUTO_SCROLL_THRESHOLD = 80;
const WORKLET_URL = new URL("../worklets/pcm-processor.js", import.meta.url);

export default function Conversation() {
  const nav = useNavigate();
  const { setTitle, setActions } = useUI();

  const [status, setStatus] = useState("Connecting…");
  const [suggestionText, setSuggestionText] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [latestInterviewerQuestion, setLatestInterviewerQuestion] = useState("");
  const [evidenceReferences, setEvidenceReferences] = useState([]);
  const [droppedAudioChunks, setDroppedAudioChunks] = useState(0);
  const [micDb, setMicDb] = useState("–∞ dB");
  const [sysDb, setSysDb] = useState("–∞ dB");
  const [micPct, setMicPct] = useState(0);
  const [sysPct, setSysPct] = useState(0);
  const [micLabel, setMicLabel] = useState(
    localStorage.getItem("micLabel") || "Mic"
  );
  const [sysLabel, setSysLabel] = useState(
    localStorage.getItem("sysLabel") || "System"
  );
  const systemAudioEnabled = localStorage.getItem("systemAudioEnabled") !== "false";

  const convoRef = useRef(null);
  const convoScrollRef = useRef(null);
  const wsRef = useRef(null);
  const ctxRef = useRef(null);
  const keepRef = useRef(null);
  const micStreamRef = useRef(null);
  const sysStreamRef = useRef(null);
  const micNodeRef = useRef(null);
  const sysNodeRef = useRef(null);
  const pausedRef = useRef(false);
  const droppedChunksRef = useRef(0);

  // helpers
  const rmsToDb = (rms) =>
    !rms || rms <= 1e-7 ? -Infinity : 20 * Math.log10(rms);
  const dbToPct = (db) => {
    const minDb = -60;
    if (db === -Infinity) return 0;
    const clamped = Math.max(minDb, Math.min(0, db));
    return ((clamped - minDb) / (0 - minDb)) * 100;
  };
  const fastB64 = (u8) => {
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  };

  function sendAudioChunk(source, buffer) {
    const ws = wsRef.current;
    if (
      shouldSendAudio({
        paused: pausedRef.current,
        readyState: ws?.readyState,
        openState: WebSocket.OPEN,
        bufferedAmount: ws?.bufferedAmount || 0,
      })
    ) {
      ws.send(JSON.stringify({ source, chunk: fastB64(new Uint8Array(buffer)) }));
      return;
    }

    if (
      !pausedRef.current &&
      ws?.readyState === WebSocket.OPEN &&
      ws.bufferedAmount > 0
    ) {
      droppedChunksRef.current += 1;
      setDroppedAudioChunks(droppedChunksRef.current);
      if (droppedChunksRef.current === 1 || droppedChunksRef.current % 25 === 0) {
        setStatus("Slow connection — limiting audio");
      }
    }
  }

  function addMessage(role, text) {
    const content = convoRef.current;
    const scroller = convoScrollRef.current;
    if (!content || !scroller) return;
    if (content.firstElementChild?.tagName === "EM") content.innerHTML = "";

    const distanceFromBottom =
      scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
    const stick = distanceFromBottom < AUTO_SCROLL_THRESHOLD;

    const wrap = document.createElement("div");
    wrap.className = `mb-3 max-w-[85%] ${
      role === "candidate" ? "ml-auto text-right" : ""
    }`;
    const roleLabel = document.createElement("div");
    roleLabel.className = "text-xs text-[var(--text-2)] mb-1";
    roleLabel.textContent = role === "candidate" ? "Candidate" : "Interviewer";
    const bubble = document.createElement("span");
    bubble.className =
      "inline-block rounded-xl px-3 py-2 " +
      (role === "candidate" ? "bg-[var(--accent-50)]" : "bg-[var(--muted)]");
    bubble.textContent = text;
    wrap.appendChild(roleLabel);
    wrap.appendChild(bubble);
    content.appendChild(wrap);
    if (stick)
      requestAnimationFrame(() =>
        scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" })
      );
  }

  function setSuggestion(text) {
    setSuggestionText(typeof text === "string" ? text : "");
  }

  function submitTypedInterviewerQuestion(question) {
    const ws = wsRef.current;
    if (pausedRef.current) {
      setStatus("Paused — resume before submitting a question");
      return;
    }
    if (ws?.readyState !== WebSocket.OPEN) {
      setStatus("Connection unavailable");
      return;
    }
    setLatestInterviewerQuestion(question);
    setSuggestion("");
    setIsThinking(true);
    setStatus("Thinking");
    ws.send(JSON.stringify({ interviewer_question: question }));
  }

  async function connectWs() {
    try {
      const wsUrl = await window.callApi.getWsUrl();
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        setStatus("Connected");
        const context = localStorage.getItem("callContext");
        if (context) ws.send(JSON.stringify({ context: JSON.parse(context) }));
      };
      ws.onclose = () => setStatus("Disconnected");
      ws.onerror = () => setStatus("Connection error");
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.speaker === "you") addMessage("candidate", msg.transcript);
          if (msg.speaker === "caller") {
            addMessage("interviewer", msg.transcript);
            setLatestInterviewerQuestion(msg.transcript);
          }
          if (msg.generation?.state === "failed") {
            setSuggestion("Guidance is unavailable right now. Transcription remains active.");
            setIsThinking(false);
            setStatus("Guidance unavailable");
          } else if (msg.ai_reply) {
            setSuggestion(msg.ai_reply);
            setIsThinking(false);
            setStatus("Listening");
          }
          if (msg.generation?.state === "thinking") {
            setSuggestion("");
            setIsThinking(true);
            setStatus("Thinking");
          }
          if (msg.error === "interview_budget_reached") {
            setSuggestion("Interview model budget reached. Suggestions are paused.");
            setIsThinking(false);
            setStatus("Model budget reached");
          }
        } catch {}
      };
    } catch {
      setStatus("Failed to connect");
    }
  }

  async function startGraph() {
    const micId = localStorage.getItem("micId");
    const sysId = localStorage.getItem("sysId");
    if (!micId || (systemAudioEnabled && !sysId)) {
      alert("Missing device selections.");
      nav("/");
      return;
    }
    if (systemAudioEnabled && micId === sysId) {
      alert("Microphone and system audio devices must be different.");
      nav("/");
      return;
    }

    const ctx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 48000,
      latencyHint: "interactive",
    });
    ctxRef.current = ctx;

    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: micId },
        channelCount: 1,
        sampleRate: 48000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    let sysStream = null;
    if (systemAudioEnabled) {
      sysStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: sysId },
          channelCount: 1,
          sampleRate: 48000,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    }
    micStreamRef.current = micStream;
    sysStreamRef.current = sysStream;

    const micSrc = ctx.createMediaStreamSource(micStream);
    const sysSrc = sysStream ? ctx.createMediaStreamSource(sysStream) : null;

    const keep = ctx.createGain();
    keep.gain.value = 0;
    keep.connect(ctx.destination);
    keepRef.current = keep;

    try {
      await ctx.audioWorklet.addModule(WORKLET_URL);
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
          const db = rmsToDb(rms);
          const pct = dbToPct(db);
          if (source === "mic") {
            setMicDb(db === -Infinity ? "–∞ dB" : `${db.toFixed(1)} dB`);
            setMicPct(pct);
          } else {
            setSysDb(db === -Infinity ? "–∞ dB" : `${db.toFixed(1)} dB`);
            setSysPct(pct);
          }
        } else if (type === "chunk" && buffer) {
          sendAudioChunk(source, buffer);
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
      // Fallback
      const frame = 4096;
      const micProc = ctx.createScriptProcessor(frame, 1, 1);
      const sysProc = sysSrc ? ctx.createScriptProcessor(frame, 1, 1) : null;

      const handle = (e, source) => {
        const input = e.inputBuffer.getChannelData(0);
        let sum = 0;
        const len = input.length;
        const out16 = new Int16Array(len);
        for (let i = 0; i < len; i++) {
          let s = input[i];
          s = Math.max(-1, Math.min(1, s));
          sum += s * s;
          out16[i] = (s * 0x7fff) | 0;
        }
        const rms = Math.sqrt(sum / len);
        const db = rmsToDb(rms);
        const pct = dbToPct(db);
        if (source === "mic") {
          setMicDb(db === -Infinity ? "–∞ dB" : `${db.toFixed(1)} dB`);
          setMicPct(pct);
        } else {
          setSysDb(db === -Infinity ? "–∞ dB" : `${db.toFixed(1)} dB`);
          setSysPct(pct);
        }
        sendAudioChunk(source, out16.buffer);
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
    setStatus("Listening");
  }

  function togglePause() {
    const nextPaused = !pausedRef.current;
    pausedRef.current = nextPaused;
    setIsPaused(nextPaused);
    setStatus(nextPaused ? "Paused" : "Listening");
  }

  function stopAll() {
    try {
      micNodeRef.current?.port?.postMessage({ type: "flush" });
      sysNodeRef.current?.port?.postMessage({ type: "flush" });
      wsRef.current?.send(JSON.stringify({ end: true }));
    } catch {}
    try {
      wsRef.current?.close();
    } catch {}
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
    micNodeRef.current = null;
    sysNodeRef.current = null;
    keepRef.current = null;
    ctxRef.current = null;
    nav("/");
  }
  useEffect(() => {
    const goIfOffline = () => {
      if (!navigator.onLine) nav("/autherror");
    };
    localStorage.setItem("lastPage", "/conversation");
    // initial check
    goIfOffline();

    // react to offline events
    window.addEventListener("offline", goIfOffline);
    return () => window.removeEventListener("offline", goIfOffline);
  }, [nav]);

  useEffect(() => {
    try {
      const context = JSON.parse(localStorage.getItem("callContext") || "null");
      setEvidenceReferences(context?.evidence || []);
    } catch {}
  }, []);

  // Show Stop button in the global top bar
  useEffect(() => {
    setTitle("Live Interview");
    setActions(
      <div className="flex gap-2">
        <Button className="h-8" variant="secondary" onClick={togglePause}>
          {isPaused ? "Resume" : "Pause"}
        </Button>
        <Button className="h-8" variant="danger" onClick={stopAll}>
          Stop
        </Button>
      </div>
    );
  }, [setTitle, setActions, isPaused]);

  useEffect(() => {
    (async () => {
      try {
        const micId = localStorage.getItem("micId");
        const sysId = localStorage.getItem("sysId");
        if (navigator.mediaDevices?.enumerateDevices) {
          const devs = await navigator.mediaDevices.enumerateDevices();
          const mic = devs.find((d) => d.deviceId === micId);
          const sys = devs.find((d) => d.deviceId === sysId);
          if (mic?.label) setMicLabel(`Mic: ${mic.label}`);
          if (sys?.label) setSysLabel(`System: ${sys.label}`);
        }
      } catch {}
    })();

    connectWs();
    startGraph();
    return () => stopAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[2.1fr_1fr] gap-3">
        <Card className="min-h-0 flex flex-col">
          <CardHeader>Conversation</CardHeader>
          <CardBody className="flex-1 min-h-0 p-0">
            <div
              ref={convoScrollRef}
              className="h-full overflow-auto no-scrollbar p-4"
            >
              <div ref={convoRef}>
                <em className="text-[var(--text-2)]">Waiting for audio…</em>
              </div>
            </div>
          </CardBody>
        </Card>

        <Card className="min-h-0 flex flex-col">
          <CardHeader>Candidate Guidance</CardHeader>
          <CardBody className="flex-1 min-h-0 overflow-auto no-scrollbar">
            <LiveGuidancePanel
              question={latestInterviewerQuestion}
              suggestion={suggestionText}
              evidence={evidenceReferences}
              isThinking={isThinking}
              onSubmitTypedQuestion={
                systemAudioEnabled ? undefined : submitTypedInterviewerQuestion
              }
            />
          </CardBody>
        </Card>
      </div>

      <StatusBar
        left={
          <>
            <span className="badge">Live</span>
            <span className="text-xs">{status}</span>
            {droppedAudioChunks > 0 && (
              <span className="hidden sm:block text-xs">
                Audio limited: {droppedAudioChunks}
              </span>
            )}
          </>
        }
        right={
          <div className="flex items-center gap-6">
            <Meter label={micLabel} pct={micPct} db={micDb} />
            {systemAudioEnabled ? (
              <Meter label={sysLabel} pct={sysPct} db={sysDb} />
            ) : (
              <span className="hidden sm:block text-xs">{sysLabel}</span>
            )}
            <span className="hidden sm:block">
              Tip: keep peaks around –12 dB
            </span>
          </div>
        }
      />
    </div>
  );
}
