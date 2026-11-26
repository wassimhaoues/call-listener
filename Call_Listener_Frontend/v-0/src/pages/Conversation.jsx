// FILE: src/pages/Conversation.jsx
import React, { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useUI } from "@/ui/UIContext.jsx";
import Button from "@/components/ui/Button.jsx";
import { Card, CardBody, CardHeader } from "@/components/ui/Card.jsx";
import Meter from "@/components/Meter.jsx";
import StatusBar from "@/components/StatusBar.jsx";
import LiveGuidancePanel from "@/components/LiveGuidancePanel.jsx";
import TranscriptLog from "@/components/TranscriptLog.jsx";
import { useAudioCapture } from "@/hooks/useAudioCapture.js";
import { useInterviewSocket } from "@/hooks/useInterviewSocket.js";
import {
  describeCaptureError,
  getDeviceSelectionError,
} from "@/services/audioCapture.js";
import {
  captureFailed,
  captureStarted,
  CONNECTION,
  CONNECTION_LOST_TEXT,
  conversationReducer,
  initialConversationState,
  noticeShown,
  pauseChanged,
  STATUS,
  typedQuestionSubmitted,
  UNSUPPORTED_MODEL_TEXT,
} from "@/services/conversationState.js";

function readStoredContext() {
  const context = localStorage.getItem("callContext");
  return context ? JSON.parse(context) : undefined;
}

export default function Conversation() {
  const nav = useNavigate();
  const { setTitle, setActions } = useUI();

  const [state, dispatch] = useReducer(conversationReducer, initialConversationState);
  const [evidenceReferences, setEvidenceReferences] = useState([]);
  const [micLabel, setMicLabel] = useState(
    localStorage.getItem("micLabel") || "Mic"
  );
  const [sysLabel, setSysLabel] = useState(
    localStorage.getItem("sysLabel") || "System"
  );
  const systemAudioEnabled = localStorage.getItem("systemAudioEnabled") !== "false";

  // Read synchronously by the audio path, so it cannot wait for a re-render.
  const pausedRef = useRef(false);
  const isPaused = useCallback(() => pausedRef.current, []);
  const stoppingRef = useRef(false);
  const mountedRef = useRef(true);

  const socket = useInterviewSocket({
    dispatch,
    isPaused,
    getContext: readStoredContext,
  });
  const capture = useAudioCapture({ onChunk: socket.sendAudioChunk });

  function submitTypedInterviewerQuestion(question) {
    if (pausedRef.current) {
      dispatch(noticeShown(STATUS.PAUSED_TYPED_QUESTION));
      return;
    }
    if (!socket.isOpen()) {
      dispatch(noticeShown(STATUS.CONNECTION_UNAVAILABLE));
      return;
    }
    dispatch(typedQuestionSubmitted(question));
    socket.sendInterviewerQuestion(question);
  }

  function togglePause() {
    const nextPaused = !pausedRef.current;
    pausedRef.current = nextPaused;
    dispatch(pauseChanged(nextPaused));
  }

  // Explicit Stop: deliver the final partial PCM batch (bounded wait), then
  // send `{ end: true }`, close, release capture, and return to setup.
  // Idempotent. This is the only path that navigates home; unmount cleanup
  // (e.g. the offline redirect) must not override where the app is going.
  async function stopSession() {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    await capture.flush();
    socket.end();
    capture.stop();
    if (mountedRef.current) nav("/");
  }

  // Capture could not start: explain why, release everything, and end the
  // socket cleanly instead of leaving a session that looks live.
  function failCapture(error) {
    stoppingRef.current = true;
    dispatch(captureFailed(describeCaptureError(error)));
    socket.end();
    capture.stop();
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
          {state.isPaused ? "Resume" : "Pause"}
        </Button>
        <Button className="h-8" variant="danger" onClick={stopSession}>
          Stop
        </Button>
      </div>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setTitle, setActions, state.isPaused]);

  useEffect(() => {
    const micId = localStorage.getItem("micId");
    const sysId = localStorage.getItem("sysId");
    mountedRef.current = true;

    (async () => {
      try {
        if (navigator.mediaDevices?.enumerateDevices) {
          const devs = await navigator.mediaDevices.enumerateDevices();
          const mic = devs.find((d) => d.deviceId === micId);
          const sys = devs.find((d) => d.deviceId === sysId);
          if (mic?.label) setMicLabel(`Mic: ${mic.label}`);
          if (sys?.label) setSysLabel(`System: ${sys.label}`);
        }
      } catch {}
    })();

    const selectionError = getDeviceSelectionError({
      micId,
      sysId,
      systemAudioEnabled,
    });
    if (selectionError) {
      alert(selectionError);
      nav("/");
      return undefined;
    }

    socket.connect();
    capture
      .start({ micId, sysId, systemAudioEnabled })
      .then((started) => {
        if (started) dispatch(captureStarted());
      })
      .catch((error) => {
        if (mountedRef.current) failCapture(error);
      });
    // The socket and capture hooks end/release themselves on unmount
    // (including a connect or getUserMedia still in flight). Never navigate
    // here.
    return () => {
      mountedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connectionLost = state.connection === CONNECTION.LOST;
  const alerts = [
    state.captureError,
    state.modelUnavailable ? UNSUPPORTED_MODEL_TEXT : "",
  ].filter(Boolean);

  return (
    <div className="h-full flex flex-col">
      {connectionLost && (
        <div
          className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--danger)] px-3 py-2 text-sm text-[var(--danger)]"
          role="alert"
        >
          <p>{CONNECTION_LOST_TEXT}</p>
          <Button className="h-8" variant="secondary" onClick={() => socket.startNewSession()}>
            Start new session
          </Button>
        </div>
      )}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[2.1fr_1fr] gap-3">
        <Card className="min-h-0 flex flex-col">
          <CardHeader>Conversation</CardHeader>
          <CardBody className="flex-1 min-h-0 p-0">
            <TranscriptLog entries={state.transcript} />
          </CardBody>
        </Card>

        <Card className="min-h-0 flex flex-col">
          <CardHeader>Candidate Guidance</CardHeader>
          <CardBody className="flex-1 min-h-0 overflow-auto no-scrollbar">
            <LiveGuidancePanel
              question={state.currentQuestion}
              suggestion={state.suggestion}
              evidence={evidenceReferences}
              isThinking={state.isThinking}
              isStreaming={state.isStreaming}
              model={state.model}
              alerts={alerts}
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
            <span className="text-xs">{state.status}</span>
            {state.droppedAudioChunks > 0 && (
              <span className="hidden sm:block text-xs">
                Audio limited: {state.droppedAudioChunks}
              </span>
            )}
          </>
        }
        right={
          <div className="flex items-center gap-6">
            <Meter label={micLabel} pct={capture.levels.mic.pct} db={capture.levels.mic.db} />
            {systemAudioEnabled ? (
              <Meter
                label={sysLabel}
                pct={capture.levels.system.pct}
                db={capture.levels.system.db}
              />
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
