import { useCallback, useEffect, useRef } from "react";
import { shouldSendAudio } from "@/services/audioBackpressure.js";
import {
  audioChunkDropped,
  CONNECTION,
  connectionChanged,
  serverMessageReceived,
} from "@/services/conversationState.js";
import {
  encodeAudioMessage,
  encodeContextMessage,
  encodeEndMessage,
  encodeInterviewerQuestionMessage,
} from "@/services/interviewMessages.js";

const WEBSOCKET_OPEN = 1;

const defaultGetWsUrl = () => window.callApi.getWsUrl();

// Owns the live interview WebSocket. Every socket event becomes a
// conversation action passed to the single `dispatch` callback; the hook keeps
// no display state of its own, so reconnect handling can be added here later
// without touching the reducer or the page.
//
// Options:
// - dispatch(action): receives conversationState actions.
// - isPaused(): read synchronously before each audio chunk.
// - getContext(): called on open; a non-undefined result is sent as context.
// - getWsUrl(): resolves the authenticated socket URL (defaults to preload).
export function useInterviewSocket({
  dispatch,
  isPaused = () => false,
  getContext = () => undefined,
  getWsUrl = defaultGetWsUrl,
}) {
  const wsRef = useRef(null);
  // Bumped by end()/unmount. A connect() whose URL resolves after that must
  // not open a socket nobody will ever close.
  const sessionRef = useRef(0);
  const optionsRef = useRef(null);
  optionsRef.current = { dispatch, isPaused, getContext, getWsUrl };

  const emit = useCallback((action) => optionsRef.current.dispatch(action), []);

  const connect = useCallback(async () => {
    const session = sessionRef.current;
    const ended = () => session !== sessionRef.current;
    let wsUrl;
    try {
      wsUrl = await optionsRef.current.getWsUrl();
    } catch {
      if (!ended()) emit(connectionChanged(CONNECTION.FAILED));
      return;
    }
    if (ended()) return;
    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        emit(connectionChanged(CONNECTION.OPEN));
        const context = optionsRef.current.getContext();
        if (context !== undefined) ws.send(encodeContextMessage(context));
      };
      ws.onclose = () => emit(connectionChanged(CONNECTION.CLOSED));
      ws.onerror = () => emit(connectionChanged(CONNECTION.ERROR));
      ws.onmessage = (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        emit(serverMessageReceived(message));
      };
    } catch {
      emit(connectionChanged(CONNECTION.FAILED));
    }
  }, [emit]);

  const isOpen = useCallback(
    () => wsRef.current?.readyState === WEBSOCKET_OPEN,
    []
  );

  // Backpressure-aware: drops the chunk (and reports it) instead of growing
  // the WebSocket send buffer past the audioBackpressure limit.
  const sendAudioChunk = useCallback(
    (source, buffer) => {
      const ws = wsRef.current;
      const paused = optionsRef.current.isPaused();
      if (
        shouldSendAudio({
          paused,
          readyState: ws?.readyState,
          openState: WEBSOCKET_OPEN,
          bufferedAmount: ws?.bufferedAmount || 0,
        })
      ) {
        ws.send(encodeAudioMessage(source, buffer));
        return;
      }

      if (!paused && ws?.readyState === WEBSOCKET_OPEN && ws.bufferedAmount > 0) {
        emit(audioChunkDropped());
      }
    },
    [emit]
  );

  // Returns false without sending when the socket is not open.
  const sendInterviewerQuestion = useCallback((question) => {
    const ws = wsRef.current;
    if (ws?.readyState !== WEBSOCKET_OPEN) return false;
    ws.send(encodeInterviewerQuestionMessage(question));
    return true;
  }, []);

  // Sends `{ end: true }` and closes. Idempotent: later calls are no-ops, and
  // a connect() still waiting for its URL will not open a socket.
  const end = useCallback(() => {
    sessionRef.current += 1;
    const ws = wsRef.current;
    if (!ws) return;
    wsRef.current = null;
    try {
      ws.send(encodeEndMessage());
    } catch {}
    try {
      ws.close();
    } catch {}
  }, []);

  useEffect(() => end, [end]);

  return { connect, isOpen, sendAudioChunk, sendInterviewerQuestion, end };
}
