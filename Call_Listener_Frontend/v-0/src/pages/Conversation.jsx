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
import DebriefPanel from "@/components/DebriefPanel.jsx";
import { useAudioCapture } from "@/hooks/useAudioCapture.js";
import { useInterviewSocket } from "@/hooks/useInterviewSocket.js";
import {
  describeCaptureError,
  getDeviceSelectionError,
} from "@/services/audioCapture.js";
import {
  canRequestResponseAction,
  captureFailed,
  captureStarted,
  CONNECTION,
  CONNECTION_LOST_TEXT,
  conversationReducer,
  initialConversationState,
  noticeShown,
  pauseChanged,
  responseActionSent,
  STATUS,
  typedQuestionSubmitted,
  UNSUPPORTED_MODEL_TEXT,
} from "@/services/conversationState.js";
import {
  DEBRIEF,
  debriefDiscarded,
  debriefReceived,
  debriefReducer,
  debriefRequested,
  followUpDraftEdited,
  initialDebriefState,
} from "@/services/debriefState.js";
import {
  buildDebriefMarkdown,
  debriefFileName,
  downloadMarkdown,
} from "@/services/debriefMarkdown.js";

const SYSTEM_AUDIO_LOST_TEXT =
  "Interviewer audio (system output) was disconnected, so it is no longer captured. Type the interviewer's questions below; your microphone is still active.";

function readStoredContext() {
  const context = localStorage.getItem("callContext");
  return context ? JSON.parse(context) : undefined;
}

export default function Conversation() {
  const nav = useNavigate();
  const { setTitle, setActions } = useUI();

  const [state, dispatch] = useReducer(conversationReducer, initialConversationState);
  // The unsaved end-of-interview review; held only in memory on this page.
  const [debrief, dispatchDebrief] = useReducer(debriefReducer, initialDebriefState);
  const reviewing = debrief.status !== DEBRIEF.IDLE;
  const [evidenceReferences, setEvidenceReferences] = useState([]);
  const [micLabel, setMicLabel] = useState(
    localStorage.getItem("micLabel") || "Mic"
  );
  const [sysLabel, setSysLabel] = useState(
    localStorage.getItem("sysLabel") || "System"
  );
  const systemAudioEnabled = localStorage.getItem("systemAudioEnabled") !== "false";
  // The interviewer device disappeared mid-interview: that source is stopped
  // and typed questions take over. Nothing is generated in its place.
  const [systemAudioLost, setSystemAudioLost] = useState(false);
  const systemAudioActive = systemAudioEnabled && !systemAudioLost;

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
  const handleSourceLost = useCallback((source) => {
    if (source === "system" && mountedRef.current) setSystemAudioLost(true);
  }, []);
  const capture = useAudioCapture({
    onChunk: socket.sendAudioChunk,
    onSourceLost: handleSourceLost,
  });

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

  const actionsEnabled = canRequestResponseAction(state);

  // Regenerate / shorten / expand / clarify the current final suggestion.
  function requestResponseAction(type) {
    if (!actionsEnabled || pausedRef.current) return;
    if (!socket.sendResponseAction(type, state.finalGenerationId)) {
      dispatch(noticeShown(STATUS.CONNECTION_UNAVAILABLE));
      return;
    }
    dispatch(responseActionSent(type));
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

  // "Stop and review": the same ordering as Stop (final audio batch, then
  // end), but the end asks for the debrief and the socket stays open until it
  // arrives. The review replaces the live view; nothing is stored.
  async function stopAndReview() {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    dispatchDebrief(debriefRequested());
    await capture.flush();
    const pending = socket.endWithReview();
    capture.stop();
    const result = await pending;
    if (mountedRef.current) dispatchDebrief(debriefReceived(result));
  }

  function exportDebrief() {
    const now = new Date();
    const markdown = buildDebriefMarkdown({
      review: debrief.review,
      followUpDraft: debrief.followUpDraft,
      evidence: evidenceReferences,
      date: now,
    });
    downloadMarkdown(markdown, debriefFileName(now));
  }

  // Discard (or cancel a review still being prepared): forget it and go home.
  function discardDebrief() {
    dispatchDebrief(debriefDiscarded());
    socket.end();
    nav("/");
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

  // Show Stop button in the global top bar; the review has its own controls.
  useEffect(() => {
    if (reviewing) {
      setTitle("Interview Review");
      setActions(null);
      return;
    }
    setTitle("Live Interview");
    setActions(
      <div className="flex gap-2">
        <Button className="h-8" variant="secondary" onClick={togglePause}>
          {state.isPaused ? "Resume" : "Pause"}
        </Button>
        <Button
          className="h-8"
          variant="ghost"
          onClick={stopAndReview}
          title="Stop the interview and prepare an unsaved review"
        >
          Stop and review
        </Button>
        <Button className="h-8" variant="danger" onClick={stopSession}>
          Stop
        </Button>
      </div>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setTitle, setActions, state.isPaused, reviewing]);

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
    systemAudioLost ? SYSTEM_AUDIO_LOST_TEXT : "",
  ].filter(Boolean);

  if (reviewing) {
    return (
      <div className="h-full flex flex-col">
        <DebriefPanel
          evidence={evidenceReferences}
          onDiscard={discardDebrief}
          onExport={exportDebrief}
          onFollowUpDraftChange={(value) => dispatchDebrief(followUpDraftEdited(value))}
          state={debrief}
        />
      </div>
    );
  }

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
              generationKind={state.generationKind}
              actionsEnabled={actionsEnabled}
              pendingAction={state.pendingAction}
              actionError={state.actionError}
              onResponseAction={requestResponseAction}
              onSubmitTypedQuestion={
                systemAudioActive ? undefined : submitTypedInterviewerQuestion
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
            {systemAudioActive ? (
              <Meter
                label={sysLabel}
                pct={capture.levels.system.pct}
                db={capture.levels.system.db}
              />
            ) : (
              <span className="hidden sm:block text-xs">
                {systemAudioLost ? "Interviewer audio disconnected" : sysLabel}
              </span>
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
