import { useCallback, useEffect, useRef } from "react";
import { shouldSendAudio } from "@/services/audioBackpressure.js";
import {
  audioChunkDropped,
  CONNECTION,
  connectionChanged,
  noticeShown,
  serverMessageReceived,
  STATUS,
} from "@/services/conversationState.js";
import {
  encodeAudioMessage,
  encodeContextMessage,
  encodeEndMessage,
  encodeInterviewerQuestionMessage,
  encodeResponseActionMessage,
  encodeResumeMessage,
} from "@/services/interviewMessages.js";
import { nextReconnectDelay, randomFraction } from "@/services/reconnectPolicy.js";
import { CLIENT_DEBRIEF_REASON } from "@/services/debriefState.js";

const WEBSOCKET_OPEN = 1;
// How long "Stop and review" waits for the debrief. The server bounds its own
// generation well below this.
export const DEBRIEF_WAIT_MS = 45_000;

const debriefFailure = (reason) => ({ status: "failed", reason });
const RESUME_FAILURES = new Set(["resume_expired", "resume_rejected"]);

// How a socket was opened: the first connection, a retry after an unexpected
// close, or a manual "Start new session".
const OPEN_MODE = {
  INITIAL: "initial",
  RECONNECT: "reconnect",
  FRESH: "fresh",
};

const defaultGetWsUrl = () => window.callApi.getWsUrl();

// The server closes a revoked installation's socket with 4003; the ticket
// request fails with a `device_revoked` error (only its message crosses IPC).
export const DEVICE_REVOKED_CLOSE_CODE = 4003;
const isRevokedError = (error) => String(error?.message ?? error ?? "").includes("device_revoked");

const emptyResume = () => ({ sessionId: null, lastSeq: 0 });
const idleReconnect = () => ({ startedAt: null, attempt: 0, timer: null });

// Owns the live interview WebSocket. Every socket event becomes a
// conversation action passed to the single `dispatch` callback; the hook keeps
// no display state of its own.
//
// Reconnection (resume-capable servers only): once the server has named the
// session (`{ session: { id } }`), an unexpected close starts bounded,
// jittered reconnect attempts. Each attempt fetches a fresh URL and sends
// `{ resume }` first; if the session is gone it starts a new session with the
// stored context. After the reconnect window the connection is reported lost
// and `startNewSession()` is the manual way back. `end()` (Stop) cancels all
// of it. Audio is dropped, never queued, until the session is live again.
//
// Options:
// - dispatch(action): receives conversationState actions.
// - isPaused(): read synchronously before each audio chunk.
// - getContext(): called when a session starts; a non-undefined result is sent as context.
// - getWsUrl(): resolves the authenticated socket URL (defaults to preload).
// - random(), now(): injectable for deterministic reconnect tests.
export function useInterviewSocket({
  dispatch,
  isPaused = () => false,
  getContext = () => undefined,
  getWsUrl = defaultGetWsUrl,
  random = randomFraction,
  now = Date.now,
}) {
  const wsRef = useRef(null);
  // Bumped by end()/unmount. A connect() whose URL resolves after that must
  // not open a socket nobody will ever close.
  const sessionRef = useRef(0);
  // True while the socket carries a live session (context sent or resumed);
  // false while connecting, reconnecting, or awaiting the resume answer.
  const readyRef = useRef(false);
  const awaitingResumeRef = useRef(false);
  const resumeRef = useRef(emptyResume());
  const reconnectRef = useRef(idleReconnect());
  const optionsRef = useRef(null);
  // Cancels a pending "Stop and review" wait (unmount, or a later end()).
  const cancelReviewRef = useRef(null);
  optionsRef.current = { dispatch, isPaused, getContext, getWsUrl, random, now };

  const emit = useCallback((action) => optionsRef.current.dispatch(action), []);

  const resetReconnect = useCallback(() => {
    clearTimeout(reconnectRef.current.timer);
    reconnectRef.current = idleReconnect();
  }, []);

  // Context goes out first on a new session, exactly as before reconnects
  // existed; `restarted` marks one that replaced an expired session.
  const startSession = useCallback(
    (ws, { restarted = false } = {}) => {
      readyRef.current = true;
      resetReconnect();
      emit(connectionChanged(CONNECTION.OPEN));
      const context = optionsRef.current.getContext();
      if (context !== undefined) ws.send(encodeContextMessage(context));
      if (restarted) emit(noticeShown(STATUS.SESSION_RESTARTED));
    },
    [emit, resetReconnect]
  );

  // Track the session ID and highest sequence number for the next resume.
  const trackSequence = useCallback((message) => {
    if (typeof message.session?.id === "string" && message.session.id) {
      resumeRef.current = { sessionId: message.session.id, lastSeq: 0 };
    }
    if (Number.isSafeInteger(message.seq) && message.seq > resumeRef.current.lastSeq) {
      resumeRef.current.lastSeq = message.seq;
    }
  }, []);

  // Returns true when the message answered a pending resume.
  const handleResumeAnswer = useCallback(
    (ws, message) => {
      if (!awaitingResumeRef.current) return false;
      if (message.resumed) {
        awaitingResumeRef.current = false;
        const seq = message.resumed.seq;
        if (Number.isSafeInteger(seq) && seq > resumeRef.current.lastSeq) {
          resumeRef.current.lastSeq = seq;
        }
        readyRef.current = true;
        resetReconnect();
        emit(connectionChanged(CONNECTION.OPEN));
        return true;
      }
      if (RESUME_FAILURES.has(message.error)) {
        awaitingResumeRef.current = false;
        resumeRef.current = emptyResume();
        startSession(ws, { restarted: true });
        return true;
      }
      return false;
    },
    [emit, resetReconnect, startSession]
  );

  // Assigned below; scheduleReconnect and openSocket refer to each other.
  const openSocketRef = useRef(null);

  const giveUp = useCallback(() => {
    resetReconnect();
    resumeRef.current = emptyResume();
    wsRef.current = null;
    emit(connectionChanged(CONNECTION.LOST));
  }, [emit, resetReconnect]);

  // The installation was disabled: stop retrying and forget the session.
  const revoke = useCallback(() => {
    resetReconnect();
    resumeRef.current = emptyResume();
    wsRef.current = null;
    readyRef.current = false;
    awaitingResumeRef.current = false;
    emit(connectionChanged(CONNECTION.REVOKED));
  }, [emit, resetReconnect]);

  const scheduleReconnect = useCallback(() => {
    const { now: clock, random: jitter } = optionsRef.current;
    const reconnect = reconnectRef.current;
    if (reconnect.startedAt === null) {
      reconnect.startedAt = clock();
      emit(connectionChanged(CONNECTION.RECONNECTING));
    }
    const delay = nextReconnectDelay({
      attempt: reconnect.attempt,
      elapsedMs: clock() - reconnect.startedAt,
      random: jitter,
    });
    if (delay === null) {
      giveUp();
      return;
    }
    reconnect.attempt += 1;
    reconnect.timer = setTimeout(() => {
      reconnect.timer = null;
      openSocketRef.current(OPEN_MODE.RECONNECT);
    }, delay);
  }, [emit, giveUp]);

  const isReconnecting = () => reconnectRef.current.startedAt !== null;

  const handleClose = useCallback(() => {
    wsRef.current = null;
    readyRef.current = false;
    awaitingResumeRef.current = false;
    // Without a server session ID (older server, or the session never
    // started) there is nothing to resume: report the close as before.
    if (isReconnecting() || resumeRef.current.sessionId !== null) {
      scheduleReconnect();
      return;
    }
    emit(connectionChanged(CONNECTION.CLOSED));
  }, [emit, scheduleReconnect]);

  const openSocket = useCallback(
    async (mode) => {
      const session = sessionRef.current;
      const ended = () => session !== sessionRef.current;
      const fail = () => {
        if (ended()) return;
        if (mode === OPEN_MODE.RECONNECT) scheduleReconnect();
        else emit(connectionChanged(CONNECTION.FAILED));
      };
      let wsUrl;
      try {
        // A fresh URL per attempt, so an expired credential is replaced.
        wsUrl = await optionsRef.current.getWsUrl();
      } catch (error) {
        if (ended()) return;
        if (isRevokedError(error)) revoke();
        else fail();
        return;
      }
      if (ended()) return;
      let ws;
      try {
        ws = new WebSocket(wsUrl);
      } catch {
        fail();
        return;
      }
      wsRef.current = ws;
      readyRef.current = false;
      ws.binaryType = "arraybuffer";
      const isCurrent = () => ws === wsRef.current;
      ws.onopen = () => {
        if (!isCurrent()) return;
        const { sessionId, lastSeq } = resumeRef.current;
        if (mode === OPEN_MODE.RECONNECT && sessionId !== null) {
          awaitingResumeRef.current = true;
          ws.send(encodeResumeMessage(sessionId, lastSeq));
          return;
        }
        startSession(ws, { restarted: mode === OPEN_MODE.RECONNECT });
      };
      ws.onclose = (event) => {
        if (!isCurrent()) return;
        if (event?.code === DEVICE_REVOKED_CLOSE_CODE) revoke();
        else handleClose();
      };
      ws.onerror = () => {
        // Failed attempts are reported by the reconnect status, not as errors.
        if (isCurrent() && !isReconnecting()) emit(connectionChanged(CONNECTION.ERROR));
      };
      ws.onmessage = (event) => {
        if (!isCurrent()) return;
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (!message || typeof message !== "object") return;
        trackSequence(message);
        if (handleResumeAnswer(ws, message)) return;
        emit(serverMessageReceived(message));
      };
    },
    [emit, handleClose, handleResumeAnswer, revoke, scheduleReconnect, startSession, trackSequence]
  );
  openSocketRef.current = openSocket;

  const connect = useCallback(() => openSocket(OPEN_MODE.INITIAL), [openSocket]);

  // Manual recovery after the connection was reported lost.
  const startNewSession = useCallback(() => {
    resetReconnect();
    resumeRef.current = emptyResume();
    emit(connectionChanged(CONNECTION.CONNECTING));
    return openSocket(OPEN_MODE.FRESH);
  }, [emit, openSocket, resetReconnect]);

  const isOpen = useCallback(
    () => readyRef.current && wsRef.current?.readyState === WEBSOCKET_OPEN,
    []
  );

  // Backpressure-aware: drops the chunk (and reports it) instead of growing
  // the WebSocket send buffer past the audioBackpressure limit. Audio while
  // reconnecting is dropped silently; the server reports the gap on resume.
  const sendAudioChunk = useCallback(
    (source, buffer) => {
      const ws = wsRef.current;
      const paused = optionsRef.current.isPaused();
      const connected = readyRef.current;
      if (
        shouldSendAudio({
          paused,
          connected,
          readyState: ws?.readyState,
          openState: WEBSOCKET_OPEN,
          bufferedAmount: ws?.bufferedAmount || 0,
        })
      ) {
        ws.send(encodeAudioMessage(source, buffer));
        return;
      }

      if (!paused && connected && ws?.readyState === WEBSOCKET_OPEN && ws.bufferedAmount > 0) {
        emit(audioChunkDropped());
      }
    },
    [emit]
  );

  // Returns false without sending when the session is not live.
  const sendInterviewerQuestion = useCallback(
    (question) => {
      if (!isOpen()) return false;
      wsRef.current.send(encodeInterviewerQuestionMessage(question));
      return true;
    },
    [isOpen]
  );

  // Asks the server to regenerate/shorten/expand/clarify the suggestion of
  // `generationId`. Returns false without sending when the session is not live.
  const sendResponseAction = useCallback(
    (type, generationId) => {
      if (!isOpen()) return false;
      wsRef.current.send(encodeResponseActionMessage(type, generationId));
      return true;
    },
    [isOpen]
  );

  // Stop the session's live use: no more reconnects, resumes, or sends, and
  // a connect() still waiting for its URL will not open a socket. Returns the
  // socket, now detached from the live handlers, or null.
  const detachSocket = useCallback(() => {
    sessionRef.current += 1;
    resetReconnect();
    resumeRef.current = emptyResume();
    readyRef.current = false;
    awaitingResumeRef.current = false;
    const ws = wsRef.current;
    wsRef.current = null;
    return ws;
  }, [resetReconnect]);

  // Sends `{ end: true }` and closes. Idempotent: later calls are no-ops, a
  // connect() still waiting for its URL will not open a socket, and any
  // pending reconnect is cancelled. Also cancels a pending review wait.
  const end = useCallback(() => {
    cancelReviewRef.current?.();
    const ws = detachSocket();
    try {
      ws.send(encodeEndMessage());
    } catch {}
    try {
      ws.close();
    } catch {}
  }, [detachSocket]);

  // "Stop and review": sends `{ end: { debrief: true } }`, keeps the socket
  // open only to receive the `{ debrief }` answer, then closes it. Resolves
  // with the server's debrief object, or a client-side failure when the
  // socket closes first or nothing arrives within `timeoutMs`. Never
  // reconnects; the review is not stored anywhere.
  const endWithReview = useCallback(
    ({ timeoutMs = DEBRIEF_WAIT_MS } = {}) => {
      const ws = detachSocket();
      if (ws?.readyState !== WEBSOCKET_OPEN) {
        try {
          ws?.close();
        } catch {
          // Already closed.
        }
        return Promise.resolve(debriefFailure(CLIENT_DEBRIEF_REASON.DISCONNECTED));
      }
      return new Promise((resolve) => {
        let timer = null;
        let settled = false;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          cancelReviewRef.current = null;
          try {
            ws.close();
          } catch {
            // Already closed.
          }
          resolve(result);
        };
        timer = setTimeout(() => finish(debriefFailure(CLIENT_DEBRIEF_REASON.NO_RESPONSE)), timeoutMs);
        cancelReviewRef.current = () => finish(debriefFailure(CLIENT_DEBRIEF_REASON.CANCELLED));
        // Every other server message (late transcripts, seq bookkeeping) is
        // irrelevant once the interview has ended.
        ws.onmessage = (event) => {
          let message;
          try {
            message = JSON.parse(event.data);
          } catch {
            return;
          }
          const debrief = message?.debrief;
          if (debrief && typeof debrief === "object") finish(debrief);
        };
        ws.onclose = () => finish(debriefFailure(CLIENT_DEBRIEF_REASON.DISCONNECTED));
        ws.onerror = () => {
          // A failed socket also closes; onclose reports it.
        };
        try {
          ws.send(encodeEndMessage({ debrief: true }));
        } catch {
          finish(debriefFailure(CLIENT_DEBRIEF_REASON.DISCONNECTED));
        }
      });
    },
    [detachSocket]
  );

  useEffect(() => end, [end]);

  return {
    connect,
    isOpen,
    sendAudioChunk,
    sendInterviewerQuestion,
    sendResponseAction,
    end,
    endWithReview,
    startNewSession,
  };
}
