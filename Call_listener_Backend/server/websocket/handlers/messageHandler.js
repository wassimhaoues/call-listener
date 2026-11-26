import { loggers } from "../../core/logger/index.js";
import {
  parseClientCapabilities,
  requestsDebrief,
  requestsSessionResume,
} from "../../contracts/interviewContext.js";
import { parseEndRequest } from "../../contracts/interviewReview.js";
import {
  isCandidateActionFrame,
  parseCandidateAction,
} from "../../contracts/candidateAction.js";

export const MAX_AUDIO_CHUNK_BYTES = 64 * 1024;
export const MAX_TYPED_INTERVIEWER_QUESTION_CHARS = 2_000;

export function isValidAudioMessage(msg) {
  if (!msg || typeof msg !== "object") return false;
  if (msg.source !== "mic" && msg.source !== "system") return false;
  const chunk = msg.chunk;
  return (
    (typeof chunk === "string" && chunk.length > 0) ||
    Buffer.isBuffer(chunk) ||
    Array.isArray(chunk) ||
    chunk instanceof ArrayBuffer ||
    (chunk?.type === "Buffer" && Array.isArray(chunk.data)) ||
    chunk instanceof Uint8Array
  );
}

export function isValidTypedInterviewerQuestion(msg) {
  return (
    typeof msg?.interviewer_question === "string" &&
    msg.interviewer_question.trim().length > 0 &&
    msg.interviewer_question.trim().length <= MAX_TYPED_INTERVIEWER_QUESTION_CHARS
  );
}

function isWebSocketOpen(wsClient) {
  return wsClient?.readyState === wsClient?.OPEN;
}

function sendJson(wsClient, payload) {
  if (isWebSocketOpen(wsClient)) {
    wsClient.send(JSON.stringify(payload));
  }
}

function toAudioBuffer(chunk) {
  if (typeof chunk === "string") return Buffer.from(chunk, "base64");
  if (Buffer.isBuffer(chunk)) return chunk;
  if (Array.isArray(chunk)) return Buffer.from(chunk);
  if (chunk?.type === "Buffer" && Array.isArray(chunk.data)) {
    return Buffer.from(chunk.data);
  }
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (chunk instanceof ArrayBuffer) return Buffer.from(new Uint8Array(chunk));
  return null;
}

/**
 * Use the stream manager's intro lifecycle when it has one; a minimal stream
 * manager (as in protocol tests) gets an always-current local controller.
 */
function beginIntro(streamManager) {
  if (typeof streamManager?.beginIntroGeneration === "function") {
    return streamManager.beginIntroGeneration();
  }
  const controller = new AbortController();
  return {
    signal: controller.signal,
    isCurrent: () => !controller.signal.aborted,
    finish: () => {},
  };
}

/**
 * Create the message handler with explicit dependencies so protocol tests can
 * run without Redis, transcription, or a model-provider connection.
 */
export function createMessageHandler({
  ChatHistory,
  ContextStore,
  generateReply,
  buildPrompt,
  parseContext = (context) => context,
  parseCapabilities = parseClientCapabilities,
  parseResumeCapability = requestsSessionResume,
  parseDebriefCapability = requestsDebrief,
  // Optional end-of-interview debrief (see services/interview/debrief.js).
  generateDebrief,
  Budget,
  isModelAllowed = () => false,
  log = loggers.websocket,
} = {}) {
  if (!ChatHistory || !ContextStore) {
    throw new TypeError("ChatHistory and ContextStore are required");
  }
  if (typeof generateReply !== "function" || typeof buildPrompt !== "function") {
    throw new TypeError("generateReply and buildPrompt are required");
  }

  // Per-session state, keyed by the session's stream manager: sessions whose
  // latest context advertised `debrief`, and sessions already ending with one.
  const debriefClients = new WeakSet();
  const endingWithDebrief = new WeakSet();

  /**
   * `{ end: true }` stops capture and model work exactly as before. A
   * debrief-capable client may send `{ end: { debrief: true } }`: the same
   * stop, then one bounded debrief generation, then the usual purge. The
   * result is sent before the purge; nothing is sent once the socket closed
   * (`beginEnd` returns a signal the session aborts on close).
   */
  async function endSession({ wsClient, sessionId, end, streamManager, onEnd, beginEnd }) {
    const request = parseEndRequest(end);
    if (!request) {
      log.warn(`⚠️ Invalid end request from [${sessionId}]`);
      sendJson(wsClient, { error: "Invalid message" });
      return;
    }
    // The session is already ending with a debrief; it purges when that finishes.
    if (endingWithDebrief.has(streamManager)) return;
    const withDebrief = request.debrief &&
      debriefClients.has(streamManager) &&
      typeof generateDebrief === "function";
    if (!withDebrief) {
      log.info(`🛑 Session [${sessionId}] ended.`);
      // An explicit end keeps the words spoken just before it.
      await streamManager.closeAll({ flushFinal: true });
      await onEnd?.();
      return;
    }
    endingWithDebrief.add(streamManager);
    const signal = beginEnd?.() ?? new AbortController().signal;
    log.info(`🛑 Session [${sessionId}] ended; preparing the debrief.`);
    try {
      // An explicit end keeps the words spoken just before it.
      await streamManager.closeAll({ flushFinal: true });
      const debrief = await generateDebrief({ sessionId, signal });
      if (debrief && !signal.aborted) sendJson(wsClient, { debrief });
    } finally {
      await onEnd?.();
    }
  }

  return async function handleMessage({
    wsClient,
    sessionId,
    data,
    streamManager,
    // Optional session-lifecycle hooks (see connectionLifecycle.js); protocol
    // tests that drive the handler directly may omit them.
    onContextAccepted,
    onEnd,
    beginEnd,
  }) {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.context) {
        log.info(`📞 Received context for [${sessionId}]`);
        let context;
        try {
          context = parseContext(msg.context);
        } catch (parseError) {
          if (parseError?.code === "unsupported_context_version") {
            // Reject explicitly: an unknown contract must never be stored as
            // an empty legacy context. The previous session context stays.
            log.warn(`⚠️ Unsupported context version rejected for [${sessionId}]`);
            sendJson(wsClient, { error: "unsupported_context_version" });
            return;
          }
          throw parseError;
        }
        // A malformed capability list rejects the whole context frame
        // ("Invalid message"); nothing below has been stored yet.
        const capabilities = parseCapabilities(msg.context);
        const resume = parseResumeCapability(msg.context);
        const selectedModel = context.settings?.model;
        if (selectedModel !== undefined && !isModelAllowed(selectedModel)) {
          // Reject rather than silently substituting another model; the
          // previously stored session context (if any) stays in effect.
          log.warn(`⚠️ Unsupported model selection rejected for [${sessionId}]`);
          sendJson(wsClient, { error: "unsupported_model" });
          return;
        }
        // Validate the language switch before storing, so a rejected context
        // cannot replace the one the active streams were opened with.
        streamManager.setTranscriptionLanguage?.(
          context.settings?.transcriptionLanguage || context.settings?.language || "fr"
        );
        await ContextStore.set(sessionId, context);
        // Capabilities follow the latest accepted context, so a client that
        // resends context without `stream` is downgraded for later generations.
        streamManager.setClientCapabilities?.(capabilities);
        if (parseDebriefCapability(msg.context)) debriefClients.add(streamManager);
        else debriefClients.delete(streamManager);
        // Session-level opt-ins (resume) are applied before any reply so the
        // introductory suggestion is already sequenced.
        onContextAccepted?.({ resume });
        // The accepted context supersedes any in-flight intro; session end and
        // socket close abort it through the stream manager's lifecycle.
        const intro = beginIntro(streamManager);
        try {
          if (!intro.isCurrent()) return;
          if (Budget && !(await Budget.canGenerate(sessionId)).allowed) {
            if (intro.isCurrent()) sendJson(wsClient, { error: "interview_budget_reached" });
            return;
          }
          const systemPrompt = buildPrompt(JSON.stringify(context), "intro");
          const historyStr = await ChatHistory.toPrompt(sessionId);
          if (!intro.isCurrent()) return;
          let modelInfo = null;
          let aiReply;
          try {
            aiReply = await generateReply(systemPrompt, historyStr, {
              signal: intro.signal,
              onUsage: (usage, estimateBasis) => Budget?.recordUsage(sessionId, usage, estimateBasis),
              model: selectedModel,
              onModel: (info) => { modelInfo = info; },
            });
          } catch (generationError) {
            if (!intro.isCurrent()) {
              log.debug?.(`Introductory suggestion aborted for [${sessionId}]`);
              return;
            }
            throw generationError;
          }
          if (!intro.isCurrent()) {
            log.debug?.(`Late introductory suggestion suppressed for [${sessionId}]`);
            return;
          }
          if (aiReply) {
            sendJson(wsClient, modelInfo ? { ai_reply: aiReply, model: modelInfo } : { ai_reply: aiReply });
          }
        } finally {
          intro.finish();
        }
        return;
      }

      if (msg.end) {
        await endSession({ wsClient, sessionId, end: msg.end, streamManager, onEnd, beginEnd });
        return;
      }

      if (isCandidateActionFrame(msg)) {
        const action = parseCandidateAction(msg);
        if (!action || typeof streamManager.requestAction !== "function") {
          log.warn(`⚠️ Invalid response action from [${sessionId}]`);
          sendJson(wsClient, { error: "Invalid message" });
          return;
        }
        // Metadata only: the action type, never suggestion text.
        log.info(`🎛️ Response action [${action.type}] for [${sessionId}]`);
        const rejection = await streamManager.requestAction(action, wsClient);
        if (rejection) sendJson(wsClient, rejection);
        return;
      }

      if (isValidTypedInterviewerQuestion(msg)) {
        await streamManager.submitInterviewerQuestion(
          msg.interviewer_question.trim(),
          wsClient
        );
        return;
      }

      if (isValidAudioMessage(msg)) {
        const buffer = toAudioBuffer(msg.chunk);
        if (!buffer?.length) {
          log.warn(`⚠️ Unsupported audio chunk type for [${sessionId}]`);
          sendJson(wsClient, { error: "Unsupported audio chunk type" });
          return;
        }
        if (buffer.length > MAX_AUDIO_CHUNK_BYTES) {
          log.warn(`⚠️ Audio chunk too large for [${sessionId}]`);
          sendJson(wsClient, { error: "Audio chunk too large" });
          return;
        }
        await streamManager.sendChunk(msg.source, buffer);
        await streamManager.ensureListeners(wsClient);
        return;
      }

      log.warn(`⚠️ Invalid message format from [${sessionId}]: %o`, msg);
      sendJson(wsClient, { error: "Invalid message" });
    } catch (err) {
      log.error(`⚠️ Message handling error [${sessionId}]: %o`, err);
      sendJson(wsClient, { error: "Invalid message" });
    }
  };
}
