import { loggers } from "../../core/logger/index.js";

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
 * Create the message handler with explicit dependencies so protocol tests can
 * run without Redis, transcription, or a model-provider connection.
 */
export function createMessageHandler({
  ChatHistory,
  ContextStore,
  generateReply,
  buildPrompt,
  parseContext = (context) => context,
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

  return async function handleMessage({
    wsClient,
    sessionId,
    data,
    streamManager,
  }) {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.context) {
        log.info(`📞 Received context for [${sessionId}]`);
        const context = parseContext(msg.context);
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
        if (Budget && !(await Budget.canGenerate(sessionId)).allowed) {
          sendJson(wsClient, { error: "interview_budget_reached" });
          return;
        }
        const systemPrompt = buildPrompt(JSON.stringify(context), "intro");
        const historyStr = await ChatHistory.toPrompt(sessionId);
        let modelInfo = null;
        const aiReply = await generateReply(systemPrompt, historyStr, {
          onUsage: (usage) => Budget?.recordUsage(sessionId, usage),
          model: selectedModel,
          onModel: (info) => { modelInfo = info; },
        });

        if (aiReply) {
          sendJson(wsClient, modelInfo ? { ai_reply: aiReply, model: modelInfo } : { ai_reply: aiReply });
        }
        return;
      }

      if (msg.end) {
        log.info(`🛑 Session [${sessionId}] ended.`);
        await streamManager.closeAll();
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
