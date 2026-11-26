import { loggers } from "../../core/logger/index.js";
import { isInterviewerQuestion } from "../interview/questionClassifier.js";
import { ACTION_REJECTION } from "../../contracts/candidateAction.js";
import { createInterimThrottle, INTERIM_MIN_INTERVAL_MS } from "./interimTranscripts.js";
import { createUtteranceDeduplicator, UTTERANCE_DEDUP_WINDOW_MS } from "./utteranceDeduplicator.js";

const SPEAKER_BY_LABEL = Object.freeze({ mic: "you", system: "caller" });

// Response actions rewrite the latest answer; clarify produces questions for
// the interviewer instead, so it never becomes the answer later actions use.
const ANSWER_KINDS = new Set(["answer", "regenerate", "shorten", "expand"]);
// Interviewer utterances since the candidate last spoke form one turn, so a
// question split across pauses ("Tell me about Acme." … "What was hard?")
// is one multipart question for response actions. A longer silence starts a
// new turn; parts and characters are bounded.
export const INTERVIEWER_TURN_WINDOW_MS = 20_000;
export const MAX_INTERVIEWER_TURN_PARTS = 4;
export const MAX_INTERVIEWER_TURN_CHARS = 2_000;
const TRANSFORM_KINDS = new Set(["shorten", "expand"]);

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
    interimIntervalMs = INTERIM_MIN_INTERVAL_MS,
    dedupWindowMs = UTTERANCE_DEDUP_WINDOW_MS,
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
    this.runInterviewWorkflow = runInterviewWorkflow || (async ({
      context, history, signal, model, onModel, onFinish, onUsage, onToken, mode = "reply", question, previousAnswer,
    }) => this.generateReply(
      this.buildPrompt(context, mode, undefined, { question, previousAnswer }),
      history,
      { signal, model, onModel, onFinish, onUsage, onToken }
    ));
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
    // Bumped by every queued request (a question or a response action); a
    // generation is current only while no newer request exists.
    this.requestVersion = 0;
    // The question response actions apply to, and its latest final answer.
    this.currentQuestion = { version: 0, text: "", answerText: null, actionCount: 0 };
    this.interviewerTurn = { parts: [], lastAt: Number.NEGATIVE_INFINITY };
    // { id, kind, questionVersion, state } of the newest generation that
    // reached the client; response actions must name its ID.
    this.latestGeneration = null;
    // Response-action cost bounds: a minimum interval between accepted
    // actions and a cap per interviewer question.
    this.ACTION_MIN_INTERVAL_MS = 1_500;
    this.MAX_ACTIONS_PER_QUESTION = 5;
    this.lastActionAt = Number.NEGATIVE_INFINITY;
    this.now = Date.now;
    this.REPLY_COOLDOWN_MS = 800;
    this.AI_TIMEOUT_MS = 12_000;
    // Streaming is opt-in per client (see setClientCapabilities). Deltas are
    // coalesced and sent at most once per STREAM_FLUSH_MS.
    this.streamingEnabled = false;
    // `actions` capability: generation IDs and kinds without streaming.
    this.generationIdsRequested = false;
    this.STREAM_FLUSH_MS = 50;
    this.generationSequence = 0;
    // `interim` capability: throttled, display-only in-progress transcript
    // lines. They are never stored, classified, or replayed.
    this.interimEnabled = false;
    this.interimThrottle = createInterimThrottle({
      intervalMs: interimIntervalMs,
      send: (label, text) => this.sendInterim(label, text),
    });
    // Near-exact repeats of a source's previous final utterance are dropped
    // before they are stored, shown, or classified.
    this.utteranceDedup = createUtteranceDeduplicator({
      windowMs: dedupWindowMs,
      now: () => this.now(),
    });
  }

  /** Apply the capabilities advertised by the latest accepted context. */
  setClientCapabilities({ stream = false, actions = false, interim = false } = {}) {
    this.streamingEnabled = stream === true;
    this.generationIdsRequested = actions === true;
    this.interimEnabled = interim === true;
    if (!this.interimEnabled) this.interimThrottle.cancelAll();
  }

  sendInterim(label, text) {
    if (this.closed || !this.interimEnabled) return;
    this.sendToClient({ interim: { speaker: SPEAKER_BY_LABEL[label], text } }, "interim");
  }

  /** An interim event from a transcription stream; empty text ends the line. */
  handleInterim(label, text) {
    // Paused or stopped streams are detached; nothing outlives them.
    if (this.closed || !this.interimEnabled || !this.streams[label]) return;
    if (text) {
      this.interimThrottle.push(label, text);
      return;
    }
    if (this.interimThrottle.settle(label)) this.sendInterim(label, "");
  }

  /**
   * A completed utterance from a transcription stream. Its interim line ends
   * here; a near-exact repeat of the previous final is dropped (and its
   * interim line cleared) so it is never stored, shown, or classified twice.
   */
  async handleTranscribedUtterance(label, text, eventGeneration) {
    const interimShown = this.interimThrottle.settle(label);
    if (this.utteranceDedup.isDuplicate(label, text)) {
      // Metadata only: never the transcript text.
      this.log.debug(`Duplicate [${label}] utterance suppressed (${text.length} chars) [${this.sessionId}]`);
      if (interimShown) this.sendInterim(label, "");
      return false;
    }
    return this.handleUtterance(label, text, eventGeneration);
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
        await this.handleTranscribedUtterance(eventLabel, text, eventGeneration);
      });
      stream.on("interim", ({ label: eventLabel, text }) => {
        this.handleInterim(eventLabel, text);
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
    // A typed question is complete on its own: it starts a new turn.
    return this.handleUtterance("system", text, this.generation, { newTurn: true });
  }

  /** Add an interviewer utterance to the current turn and return the turn's text. */
  extendInterviewerTurn(text, { newTurn = false } = {}) {
    const now = this.now();
    if (newTurn || now - this.interviewerTurn.lastAt > INTERVIEWER_TURN_WINDOW_MS) {
      this.interviewerTurn = { parts: [], lastAt: now };
    }
    this.interviewerTurn.parts = [...this.interviewerTurn.parts, text].slice(-MAX_INTERVIEWER_TURN_PARTS);
    this.interviewerTurn.lastAt = now;
    // Keep the end: the latest words are the question being asked.
    return this.interviewerTurn.parts.join(" ").slice(-MAX_INTERVIEWER_TURN_CHARS);
  }

  async handleUtterance(eventLabel, text, eventGeneration, { newTurn = false } = {}) {
    if (this.closed) return false;
    const role = eventLabel === "mic" ? "you" : "caller";
    try {
      await this.ChatHistory.push(this.sessionId, role, text);
    } catch (error) {
      this.log.error(`❌ Failed saving transcript [${this.sessionId}]: %o`, error);
    }
    if (this.closed || eventGeneration !== this.generation) return false;

    if (this.wsClient && this.wsClient.readyState === this.wsClient.OPEN) {
      try {
        this.wsClient.send(JSON.stringify({ speaker: role, transcript: text }));
      } catch (sendError) {
        this.log.error(
          `❌ WS send transcript failed [${this.sessionId}]: %o`,
          sendError
        );
      }
    }

    if (eventLabel !== "system") {
      // The candidate spoke: the interviewer's next words start a new turn.
      this.interviewerTurn = { parts: [], lastAt: Number.NEGATIVE_INFINITY };
      return true;
    }
    const turnText = this.extendInterviewerTurn(text, { newTurn });
    if (!isInterviewerQuestion(text)) {
      this.log.debug(`Skipping non-question interviewer turn [${this.sessionId}]`);
      return true;
    }
    this.queueQuestion(eventGeneration, turnText);
    return true;
  }

  queueQuestion(sessionGeneration, text = "") {
    if (this.closed) return;
    this.questionVersion += 1;
    this.currentQuestion = { version: this.questionVersion, text, answerText: null, actionCount: 0 };
    this.enqueueRequest({ sessionGeneration, questionVersion: this.questionVersion, kind: "answer" });
  }

  /**
   * Latest request wins: a newer question or response action replaces any
   * queued one and aborts the generation in flight.
   */
  enqueueRequest(request) {
    this.requestVersion += 1;
    this.pendingQuestion = { ...request, requestVersion: this.requestVersion };
    if (this.isResponding) {
      this.activeGenerationController?.abort(new Error("superseded by a newer request"));
    }
    this.scheduleReply();
  }

  /** Why `action` cannot run now, or null when it can. */
  actionRejection(action) {
    const latest = this.latestGeneration;
    const question = this.currentQuestion;
    if (latest?.id !== action.generationId || latest.questionVersion !== question.version) {
      return ACTION_REJECTION.STALE_GENERATION;
    }
    if (TRANSFORM_KINDS.has(action.type) && !question.answerText) {
      return ACTION_REJECTION.NO_FINAL_ANSWER;
    }
    if (question.actionCount >= this.MAX_ACTIONS_PER_QUESTION) {
      return ACTION_REJECTION.QUESTION_LIMIT_REACHED;
    }
    if (this.now() - this.lastActionAt < this.ACTION_MIN_INTERVAL_MS) {
      return ACTION_REJECTION.RATE_LIMITED;
    }
    return null;
  }

  /**
   * Run a validated candidate response action (`{ type, generationId }`) as a
   * new generation for the current question. Returns null when it was
   * queued (or ignored after end), otherwise the error payload to send.
   */
  async requestAction(action, wsClient) {
    if (this.closed) return null;
    if (wsClient) this.wsClient = wsClient;
    if (this.Budget && !(await this.Budget.canGenerate(this.sessionId)).allowed) {
      return { error: "interview_budget_reached" };
    }
    if (this.closed) return null;
    const reason = this.actionRejection(action);
    if (reason) return { error: "action_rejected", reason };
    const question = this.currentQuestion;
    question.actionCount += 1;
    this.lastActionAt = this.now();
    this.enqueueRequest({
      sessionGeneration: this.generation,
      questionVersion: question.version,
      kind: action.type,
      question: question.text,
      // Transforms work on the latest final answer; it reaches the model as
      // quoted data, never as instructions.
      previousAnswer: TRANSFORM_KINDS.has(action.type) ? question.answerText : undefined,
    });
    return null;
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

  async generateSuggestion({
    sessionGeneration,
    questionVersion,
    requestVersion,
    kind = "answer",
    question,
    previousAnswer,
  }) {
    this.isResponding = true;
    const generationController = new AbortController();
    this.activeGenerationController = generationController;
    // Opaque and unique per session; clients only compare it for equality.
    this.generationSequence += 1;
    const generationId = `g${this.generationSequence}`;
    // Pinned per generation: a capability change applies to the next one.
    const streaming = this.streamingEnabled;
    // IDs and kinds go to streaming clients and to `actions` clients.
    const identity = (streaming || this.generationIdsRequested)
      ? { id: generationId, kind }
      : undefined;
    const tag = (state) => ({ ...identity, state });
    const activeGeneration = { id: generationId, identity };
    this.activeGeneration = activeGeneration;
    const generationRecord = { id: generationId, kind, questionVersion, state: "running" };
    const isCurrent = () =>
      !this.closed &&
      !generationController.signal.aborted &&
      sessionGeneration === this.generation &&
      requestVersion === this.requestVersion;
    const deltas = streaming
      ? createDeltaBatcher({
        flushMs: this.STREAM_FLUSH_MS,
        isCurrent,
        send: (delta) => this.sendToClient({ generation: tag("streaming"), delta }, "delta"),
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
      let truncated = false;
      const historyStr = await this.ChatHistory.toPrompt(this.sessionId);
      if (!isCurrent()) return;
      this.latestGeneration = generationRecord;
      this.sendToClient({ generation: tag("thinking") }, "thinking");
      const aiText = await withTimeout(
        this.runInterviewWorkflow({
          context: contextStr,
          history: historyStr,
          mode: kind === "answer" ? "reply" : kind,
          question,
          previousAnswer,
          signal: generationController.signal,
          onUsage: (usage, estimateBasis) => this.Budget?.recordUsage(this.sessionId, usage, estimateBasis),
          model: selectedModel,
          onModel: (info) => { modelInfo = info; },
          onFinish: (finish) => { truncated = finish?.truncated === true; },
          onToken: deltas ? (token) => deltas.push(token) : undefined,
        }),
        this.AI_TIMEOUT_MS,
        generationController,
        "generateReply"
      );
      const finalText = (aiText || "").trim();
      const isLatestRequest = () =>
        !this.closed &&
        sessionGeneration === this.generation &&
        requestVersion === this.requestVersion;
      if (!isLatestRequest()) return;
      if (!finalText) {
        deltas?.cancel();
        generationRecord.state = "failed";
        sendGenerationFailure(this.wsClient, identity);
        return;
      }
      // Only interview answers join the conversation history; action outputs
      // are alternative renderings of guidance the candidate asked for.
      if (kind === "answer") await this.ChatHistory.push(this.sessionId, "assistant", finalText);
      if (!isLatestRequest()) return;
      // Deliver any coalesced tail before the terminal message so deltas are
      // never reordered after `done`.
      deltas?.flush();
      deltas?.cancel();
      generationRecord.state = "done";
      if (ANSWER_KINDS.has(kind) && this.currentQuestion.version === questionVersion) {
        this.currentQuestion.answerText = finalText;
      }
      const reply = modelInfo ? { ai_reply: finalText, model: modelInfo } : { ai_reply: finalText };
      // Additive: a streaming client learns the answer was cut at the cap.
      const done = truncated ? { ...tag("done"), truncated: true } : tag("done");
      this.sendToClient(identity ? { ...reply, generation: done } : reply, "reply");
    } catch (error) {
      const superseded = generationController.signal.aborted && requestVersion !== this.requestVersion;
      if (!superseded) {
        this.log.error(`❌ AI pipeline failure [${this.sessionId}]: %o`, error);
      }
      if (
        !superseded &&
        !this.closed &&
        sessionGeneration === this.generation &&
        requestVersion === this.requestVersion
      ) {
        generationRecord.state = "failed";
        sendGenerationFailure(this.wsClient, identity);
      }
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

  /**
   * The last words flushed when an interview ends explicitly: stored in the
   * history (so the debrief sees the final answer) and shown to the client.
   * The session is already closed, so no generation is started.
   */
  async recordFinalUtterance(label, text) {
    const role = SPEAKER_BY_LABEL[label] ?? "caller";
    try {
      await this.ChatHistory.push(this.sessionId, role, text);
    } catch (error) {
      this.log.error(`❌ Failed saving final transcript [${this.sessionId}]: %o`, error);
    }
    if (this.wsClient && this.wsClient.readyState === this.wsClient.OPEN) {
      try {
        this.wsClient.send(JSON.stringify({ speaker: role, transcript: text }));
      } catch (sendError) {
        this.log.error(`❌ WS send final transcript failed [${this.sessionId}]: %o`, sendError);
      }
    }
  }

  /**
   * Detach and stop the current transcription streams. With `flushFinal`,
   * each stream first finalizes buffered audio and its remaining text is
   * recorded (see recordFinalUtterance).
   */
  async stopStreams({ flushFinal = false } = {}) {
    const streams = Object.entries(this.streams);
    this.streams = {};
    this.listenersAttached = {};
    // No interim line outlives its stream: pending text and timers are dropped.
    this.interimThrottle.cancelAll();
    await Promise.allSettled(
      streams.map(async ([label, stream]) => {
        try {
          stream.removeAllListeners?.("utterance");
          stream.removeAllListeners?.("interim");
          if (flushFinal) {
            stream.on?.("utterance", ({ label: eventLabel, text }) => this.recordFinalUtterance(eventLabel ?? label, text));
          }
          await stream.stop({ flush: flushFinal });
          stream.removeAllListeners?.("utterance");
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
    const queuedAction = this.pendingQuestion && this.pendingQuestion.kind !== "answer";
    this.activeGeneration = null;
    this.cancelPendingWork("client disconnected");
    if (interrupted) {
      if (this.latestGeneration?.id === interrupted.id) this.latestGeneration.state = "failed";
      sendGenerationFailure(this.wsClient, interrupted.identity, "disconnected");
    }
    // A response action still waiting for its turn never started: report it
    // so the client stops waiting for it. It is never run later.
    if (queuedAction) {
      this.sendToClient({ error: "action_rejected", reason: "disconnected" }, "action rejection");
    }
    this.log.info(`⏸️ Pausing Deepgram streams for session [${this.sessionId}]`);
    await this.stopStreams();
  }

  /**
   * Close the session's streams and stop all model work. `flushFinal` (an
   * explicit end) keeps the words spoken just before it: see stopStreams.
   */
  async closeAll({ flushFinal = false } = {}) {
    if (this.closePromise) return this.closePromise;

    this.closed = true;
    this.activeGeneration = null;
    this.cancelPendingWork("session closed");
    this.closePromise = (async () => {
      this.log.info(`🧹 Closing all Deepgram streams for session [${this.sessionId}]`);
      await this.stopStreams({ flushFinal });
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

function failedGeneration(identity, reason) {
  const generation = { ...identity, state: "failed" };
  if (reason) generation.reason = reason;
  return generation;
}

/** `identity` is `{ id, kind }` for clients that receive generation IDs. */
function sendGenerationFailure(wsClient, identity, reason) {
  if (wsClient?.readyState !== wsClient?.OPEN) return;
  try {
    wsClient.send(JSON.stringify({
      generation: failedGeneration(identity, reason),
      // Retained for older desktop clients that only understand final replies.
      ai_reply: "[Erreur du modèle]",
    }));
  } catch {}
}
