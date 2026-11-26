import { loggers } from "../../core/logger/index.js";
import { isInterviewerQuestion } from "../interview/questionClassifier.js";

function withTimeout(operation, ms, controller, label = "operation") {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      controller?.abort(new Error(`Timeout after ${ms}ms: ${label}`));
      reject(new Error(`Timeout after ${ms}ms: ${label}`));
    }, ms);
    Promise.resolve(operation).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * Owns a session's live transcription streams and model-response lifecycle.
 * Dependencies are explicit so lifecycle behavior can be tested without
 * provider credentials or a Redis connection.
 */
export class StreamManager {
  constructor(sessionId, {
    createTranscriptionStream,
    ChatHistory,
    ContextStore,
    generateReply,
    buildPrompt,
    runInterviewWorkflow,
    Budget,
    log = loggers.deepgram,
  } = {}) {
    if (typeof createTranscriptionStream !== "function") {
      throw new TypeError("createTranscriptionStream is required");
    }
    if (!ChatHistory || !ContextStore) {
      throw new TypeError("ChatHistory and ContextStore are required");
    }
    if (typeof generateReply !== "function" || typeof buildPrompt !== "function") {
      throw new TypeError("generateReply and buildPrompt are required");
    }

    this.sessionId = sessionId;
    this.createTranscriptionStream = createTranscriptionStream;
    this.ChatHistory = ChatHistory;
    this.ContextStore = ContextStore;
    this.generateReply = generateReply;
    this.buildPrompt = buildPrompt;
    this.runInterviewWorkflow = runInterviewWorkflow || (async ({ context, history, signal, model, onModel, onUsage, onToken }) =>
      this.generateReply(this.buildPrompt(context, "reply"), history, { signal, model, onModel, onUsage, onToken }));
    this.Budget = Budget;
    this.log = log;
    this.streams = {};
    this.streamStarts = {};
    this.listenersAttached = {};
    this.isResponding = false;
    this.wsClient = null;
    this.lastReplyAt = 0;
    this.closed = false;
    this.closePromise = null;
    this.generation = 0;
    this.transcriptionLanguage = "fr";
    this.activeGenerationController = null;
    // { id, streaming } of the generation in flight, reported as failed if the
    // client disconnects before it completes (see pause()).
    this.activeGeneration = null;
    this.activeIntroController = null;
    this.pendingQuestion = null;
    this.replyTimer = null;
    this.questionVersion = 0;
    this.REPLY_COOLDOWN_MS = 800;
    this.AI_TIMEOUT_MS = 12_000;
    // Streaming is opt-in per client (see setClientCapabilities). Deltas are
    // coalesced and sent at most once per STREAM_FLUSH_MS.
    this.streamingEnabled = false;
    this.STREAM_FLUSH_MS = 50;
    this.generationSequence = 0;
  }

  /** Apply the capabilities advertised by the latest accepted context. */
  setClientCapabilities({ stream = false } = {}) {
    this.streamingEnabled = stream === true;
  }

  sendToClient(payload, label = "message") {
    if (this.wsClient?.readyState !== this.wsClient?.OPEN) return;
    try {
      this.wsClient.send(JSON.stringify(payload));
    } catch (sendError) {
      this.log.error(`❌ WS send ${label} failed [${this.sessionId}]: %o`, sendError);
    }
  }

  async getOrCreate(label) {
    if (this.closed) throw new Error("session is closed");
    if (this.streams[label]) return this.streams[label];
    if (this.streamStarts[label]) return this.streamStarts[label];

    const start = (async () => {
      const stream = this.createTranscriptionStream(label, this.transcriptionLanguage);
      await stream.start();
      if (this.closed) {
        await stream.stop();
        throw new Error("session closed while stream was starting");
      }
      this.streams[label] = stream;
      this.log.info(
        `🎧 Created Deepgram stream [${label}] for session [${this.sessionId}]`
      );
      return stream;
    })();
    this.streamStarts[label] = start;
    try {
      return await start;
    } finally {
      delete this.streamStarts[label];
    }
  }

  async sendChunk(label, chunk) {
    if (this.closed) return false;
    try {
      const stream = await this.getOrCreate(label);
      if (this.closed) return false;
      stream.sendChunk(chunk);
      return true;
    } catch (err) {
      this.log.error(
        `❌ Failed to send audio chunk to [${label}] for session [${this.sessionId}]: %o`,
        err
      );
      return false;
    }
  }

  setTranscriptionLanguage(language) {
    if (!new Set(["fr", "en"]).has(language)) {
      throw new TypeError("transcription language must be fr or en");
    }
    if (Object.keys(this.streams).length && language !== this.transcriptionLanguage) {
      throw new Error("cannot change transcription language during capture");
    }
    this.transcriptionLanguage = language;
  }

  async ensureListeners(wsClient) {
    if (this.closed) return;
    this.wsClient = wsClient;

    for (const label of ["mic", "system"]) {
      const stream = this.streams[label];
      if (!stream || this.listenersAttached[label]) continue;

      stream.on("utterance", async ({ label: eventLabel, text }) => {
        const eventGeneration = this.generation;
        await this.handleUtterance(eventLabel, text, eventGeneration);
      });

      this.listenersAttached[label] = true;
      this.log.debug(
        `🔗 Attached utterance listener for [${label}] on session [${this.sessionId}]`
      );
    }
  }

  async submitInterviewerQuestion(text, wsClient) {
    if (this.closed) return false;
    if (wsClient) this.wsClient = wsClient;
    return this.handleUtterance("system", text, this.generation);
  }

  async handleUtterance(eventLabel, text, eventGeneration) {
    if (this.closed) return false;
    const role = eventLabel === "mic" ? "you" : "caller";
    try {
      await this.ChatHistory.push(this.sessionId, role, text);
    } catch (error) {
      this.log.error(`❌ Failed saving transcript [${this.sessionId}]: %o`, error);
    }
    if (this.closed || eventGeneration !== this.generation) return false;

    if (this.wsClient?.readyState === this.wsClient.OPEN) {
      try {
        this.wsClient.send(JSON.stringify({ speaker: role, transcript: text }));
      } catch (sendError) {
        this.log.error(
          `❌ WS send transcript failed [${this.sessionId}]: %o`,
          sendError
        );
      }
    }

    if (eventLabel !== "system") return true;
    if (!isInterviewerQuestion(text)) {
      this.log.debug(`Skipping non-question interviewer turn [${this.sessionId}]`);
      return true;
    }
    this.queueQuestion(eventGeneration);
    return true;
  }

  queueQuestion(sessionGeneration) {
    if (this.closed) return;
    this.questionVersion += 1;
    this.pendingQuestion = { sessionGeneration, questionVersion: this.questionVersion };
    if (this.isResponding) {
      this.activeGenerationController?.abort(new Error("superseded by newer interviewer question"));
    }
    this.scheduleReply();
  }

  scheduleReply() {
    if (this.closed || this.isResponding || !this.pendingQuestion || this.replyTimer) return;
    const delay = Math.max(0, this.lastReplyAt + this.REPLY_COOLDOWN_MS - Date.now());
    if (delay) {
      this.replyTimer = setTimeout(() => {
        this.replyTimer = null;
        this.scheduleReply();
      }, delay);
      return;
    }
    const question = this.pendingQuestion;
    this.pendingQuestion = null;
    void this.generateSuggestion(question);
  }

  async generateSuggestion({ sessionGeneration, questionVersion }) {
    this.isResponding = true;
    const generationController = new AbortController();
    this.activeGenerationController = generationController;
    // Opaque and unique per session; clients only compare it for equality.
    this.generationSequence += 1;
    const generationId = `g${this.generationSequence}`;
    // Pinned per generation: a capability change applies to the next one.
    const streaming = this.streamingEnabled;
    const activeGeneration = { id: generationId, streaming };
    this.activeGeneration = activeGeneration;
    const isCurrent = () =>
      !this.closed &&
      !generationController.signal.aborted &&
      sessionGeneration === this.generation &&
      questionVersion === this.questionVersion;
    const deltas = streaming
      ? createDeltaBatcher({
        flushMs: this.STREAM_FLUSH_MS,
        isCurrent,
        send: (delta) => this.sendToClient(
          { generation: { id: generationId, state: "streaming" }, delta },
          "delta"
        ),
      })
      : null;
    try {
      const contextObj = await this.ContextStore.get(this.sessionId);
      const budget = this.Budget
        ? await this.Budget.canGenerate(this.sessionId)
        : { allowed: true };
      if (!budget.allowed) {
        sendBudgetError(this.wsClient);
        return;
      }
      const contextStr = contextObj ? JSON.stringify(contextObj) : "";
      // Session-scoped model choice: read per generation so a settings change
      // applies to the next request, never to one already in flight.
      const selectedModel = contextObj?.settings?.model;
      let modelInfo = null;
      const historyStr = await this.ChatHistory.toPrompt(this.sessionId);
      if (this.wsClient?.readyState === this.wsClient.OPEN) {
        this.wsClient.send(JSON.stringify({
          generation: streaming ? { id: generationId, state: "thinking" } : { state: "thinking" },
        }));
      }
      const aiText = await withTimeout(
        this.runInterviewWorkflow({
          context: contextStr,
          history: historyStr,
          signal: generationController.signal,
          onUsage: (usage, estimateBasis) => this.Budget?.recordUsage(this.sessionId, usage, estimateBasis),
          model: selectedModel,
          onModel: (info) => { modelInfo = info; },
          onToken: deltas ? (token) => deltas.push(token) : undefined,
        }),
        this.AI_TIMEOUT_MS,
        generationController,
        "generateReply"
      );
      const finalText = (aiText || "").trim();
      if (
        this.closed ||
        sessionGeneration !== this.generation ||
        questionVersion !== this.questionVersion
      ) return;
      if (!finalText) {
        deltas?.cancel();
        sendGenerationFailure(this.wsClient, streaming ? generationId : undefined);
        return;
      }
      await this.ChatHistory.push(this.sessionId, "assistant", finalText);
      if (this.closed || sessionGeneration !== this.generation || questionVersion !== this.questionVersion) return;
      // Deliver any coalesced tail before the terminal message so deltas are
      // never reordered after `done`.
      deltas?.flush();
      deltas?.cancel();
      const reply = modelInfo ? { ai_reply: finalText, model: modelInfo } : { ai_reply: finalText };
      this.sendToClient(
        streaming ? { ...reply, generation: { id: generationId, state: "done" } } : reply,
        "reply"
      );
    } catch (error) {
      const superseded = generationController.signal.aborted && questionVersion !== this.questionVersion;
      if (!superseded) {
        this.log.error(`❌ AI pipeline failure [${this.sessionId}]: %o`, error);
      }
      if (
        !superseded &&
        !this.closed &&
        sessionGeneration === this.generation &&
        questionVersion === this.questionVersion
      ) sendGenerationFailure(this.wsClient, streaming ? generationId : undefined);
    } finally {
      // Terminal for this generation: drop any buffered tail and its timer.
      deltas?.cancel();
      if (this.activeGenerationController === generationController) {
        this.activeGenerationController = null;
      }
      if (this.activeGeneration === activeGeneration) this.activeGeneration = null;
      this.isResponding = false;
      this.lastReplyAt = Date.now();
      this.scheduleReply();
    }
  }

  /**
   * Start the lifecycle of one introductory suggestion. A newer intro (from a
   * newer context message) aborts the previous one, and so does session end or
   * socket close. Callers must check `isCurrent()` before sending output.
   */
  beginIntroGeneration() {
    this.activeIntroController?.abort(new Error("superseded by newer context"));
    const controller = new AbortController();
    if (this.closed) {
      controller.abort(new Error("session closed"));
    } else {
      this.activeIntroController = controller;
    }
    const sessionGeneration = this.generation;
    return {
      signal: controller.signal,
      isCurrent: () =>
        !this.closed &&
        !controller.signal.aborted &&
        sessionGeneration === this.generation &&
        this.activeIntroController === controller,
      finish: () => {
        if (this.activeIntroController === controller) this.activeIntroController = null;
      },
    };
  }

  /** Abort model work and drop queued questions; late output becomes stale. */
  cancelPendingWork(reason) {
    this.generation += 1;
    this.activeGenerationController?.abort(new Error(reason));
    this.activeIntroController?.abort(new Error(reason));
    this.activeIntroController = null;
    clearTimeout(this.replyTimer);
    this.replyTimer = null;
    this.pendingQuestion = null;
  }

  /** Detach and stop the current transcription streams. */
  async stopStreams() {
    const streams = Object.entries(this.streams);
    this.streams = {};
    this.listenersAttached = {};
    await Promise.allSettled(
      streams.map(async ([label, stream]) => {
        try {
          stream.removeAllListeners?.("utterance");
          await stream.stop();
          this.log.debug(`🔻 Closed [${label}] stream`);
        } catch (error) {
          this.log.error(`❌ Error closing [${label}] stream: %o`, error);
        }
      })
    );
  }

  /**
   * Suspend a resumable session whose client disconnected. Unlike closeAll()
   * the session stays usable: in-flight generation and intro are aborted and
   * never re-run, queued questions are dropped, and the transcription streams
   * are stopped; the next audio chunk after a resume reopens them lazily.
   *
   * A generation that was in flight is reported as failed (`reason:
   * "disconnected"`), so a resuming client learns it will not complete. The
   * report is sent synchronously, before any await, so it is sequenced ahead
   * of a resume replay.
   */
  async pause() {
    if (this.closed) return;
    const interrupted = this.activeGeneration;
    this.activeGeneration = null;
    this.cancelPendingWork("client disconnected");
    if (interrupted) {
      sendGenerationFailure(
        this.wsClient,
        interrupted.streaming ? interrupted.id : undefined,
        "disconnected"
      );
    }
    this.log.info(`⏸️ Pausing Deepgram streams for session [${this.sessionId}]`);
    await this.stopStreams();
  }

  async closeAll() {
    if (this.closePromise) return this.closePromise;

    this.closed = true;
    this.activeGeneration = null;
    this.cancelPendingWork("session closed");
    this.closePromise = (async () => {
      this.log.info(`🧹 Closing all Deepgram streams for session [${this.sessionId}]`);
      await this.stopStreams();
      this.isResponding = false;
    })();
    return this.closePromise;
  }

  isActive(label) {
    return !!this.streams[label];
  }

  summarize() {
    const activeLabels = Object.keys(this.streams);
    return {
      sessionId: this.sessionId,
      activeStreams: activeLabels,
      activeCount: activeLabels.length,
      closed: this.closed,
    };
  }
}

function sendBudgetError(wsClient) {
  if (wsClient?.readyState !== wsClient?.OPEN) return;
  try {
    wsClient.send(JSON.stringify({ error: "interview_budget_reached" }));
  } catch {}
}

/**
 * Coalesce streamed tokens into deltas sent at most once per `flushMs`.
 * Nothing is sent once the generation stops being current (superseded,
 * aborted, ended, or closed) or after `cancel()`.
 */
export function createDeltaBatcher({ flushMs, isCurrent, send }) {
  let buffer = "";
  let timer = null;
  let cancelled = false;

  function cancel() {
    cancelled = true;
    clearTimeout(timer);
    timer = null;
    buffer = "";
  }

  function flush() {
    clearTimeout(timer);
    timer = null;
    if (cancelled || !buffer) return;
    if (!isCurrent()) {
      cancel();
      return;
    }
    const delta = buffer;
    buffer = "";
    send(delta);
  }

  return {
    push(token) {
      if (cancelled || typeof token !== "string" || !token) return;
      if (!isCurrent()) {
        cancel();
        return;
      }
      buffer += token;
      if (!timer) timer = setTimeout(flush, flushMs);
    },
    flush,
    cancel,
  };
}

function failedGeneration(generationId, reason) {
  const generation = generationId ? { id: generationId, state: "failed" } : { state: "failed" };
  if (reason) generation.reason = reason;
  return generation;
}

function sendGenerationFailure(wsClient, generationId, reason) {
  if (wsClient?.readyState !== wsClient?.OPEN) return;
  try {
    wsClient.send(JSON.stringify({
      generation: failedGeneration(generationId, reason),
      // Retained for older desktop clients that only understand final replies.
      ai_reply: "[Erreur du modèle]",
    }));
  } catch {}
}
