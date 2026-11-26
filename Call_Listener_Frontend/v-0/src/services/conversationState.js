// Pure transcript + generation state for the live interview workspace.
// Every state change flows through `conversationReducer`, so the socket and
// capture hooks only dispatch actions and never own display state.
//
// `status` is never set directly: after every action it is derived from the
// underlying facts (connection, capture, pause, generation, notices), so the
// displayed status cannot depend on which asynchronous event landed last.

export const STATUS = {
  CONNECTING: "Connecting…",
  CONNECTED: "Connected",
  DISCONNECTED: "Disconnected",
  CONNECTION_ERROR: "Connection error",
  CONNECTION_UNAVAILABLE: "Connection unavailable",
  FAILED_TO_CONNECT: "Failed to connect",
  LISTENING: "Listening",
  PAUSED: "Paused",
  PAUSED_TYPED_QUESTION: "Paused — resume before submitting a question",
  THINKING: "Thinking",
  GUIDANCE_UNAVAILABLE: "Guidance unavailable",
  BUDGET_REACHED: "Model budget reached",
  MODEL_UNAVAILABLE: "Selected model unavailable",
  SLOW_CONNECTION: "Slow connection — limiting audio",
  CAPTURE_FAILED: "Audio capture unavailable",
  RECONNECTING: "Reconnecting…",
  CONNECTION_LOST: "Connection lost",
  AUDIO_GAP: "Reconnected — audio during the interruption was not transcribed",
  SESSION_RESTARTED: "Reconnected — new session started",
  DEVICE_REVOKED: "Installation disabled",
};

export const CONNECTION = {
  CONNECTING: "connecting",
  OPEN: "open",
  CLOSED: "closed",
  ERROR: "error",
  FAILED: "failed",
  // Resumable sessions only: the socket dropped and the client is retrying.
  RECONNECTING: "reconnecting",
  // Reconnection gave up after the resume window; only a manual restart helps.
  LOST: "lost",
  // The server disabled this installation (close 4003 / HTTP 403
  // device_revoked). Terminal: reconnecting cannot help.
  REVOKED: "revoked",
};

// Connection states after which no generation can finish.
const isTerminalConnection = (connection) =>
  connection === CONNECTION.LOST || connection === CONNECTION.REVOKED;

const GENERATION = {
  IDLE: "idle",
  THINKING: "thinking",
  STREAMING: "streaming",
  FAILED: "failed",
  BUDGET_REACHED: "budget_reached",
};

export const GUIDANCE_UNAVAILABLE_TEXT =
  "Guidance is unavailable right now. Transcription remains active.";
export const BUDGET_REACHED_TEXT =
  "Interview model budget reached. Suggestions are paused.";
export const UNSUPPORTED_MODEL_TEXT =
  "The AI model chosen in Interview Settings isn't available. Stop the session, pick another model in Interview Settings, and start again.";
export const DEVICE_REVOKED_TEXT =
  "This installation has been disabled by the Call Listener service, so it can no longer connect. Contact support if you think this is a mistake.";
export const CONNECTION_LOST_TEXT =
  "The connection to the server was lost and could not be restored. Start a new session to continue; guidance will not include the earlier conversation.";

// Bound the rendered transcript so a long interview cannot grow the DOM and
// state without limit. The newest entries are kept.
export const MAX_TRANSCRIPT_ENTRIES = 500;
const MAX_MODEL_NAME_CHARS = 160;
// Bound streamed text so a misbehaving server cannot grow state without limit.
// The server caps output tokens far below this.
export const MAX_STREAMED_SUGGESTION_CHARS = 20_000;

// Report congestion on the first dropped chunk and then every Nth one, so the
// status line does not flicker on every 20 ms batch.
const DROPPED_CHUNK_STATUS_INTERVAL = 25;

// `generation.kind` values the server reports: a normal answer, or the
// response action that produced the suggestion. Anything else is ignored.
export const GENERATION_KINDS = Object.freeze(["answer", "regenerate", "shorten", "expand", "clarify"]);

// Candidate-facing explanations for `{ error: "action_rejected", reason }`.
export const ACTION_REJECTION_TEXT = Object.freeze({
  stale_generation: "That suggestion is no longer current, so it can't be changed.",
  no_final_answer: "There is no finished answer to change yet.",
  rate_limited: "Too many requests. Wait a moment and try again.",
  question_limit_reached: "Action limit reached for this question.",
  disconnected: "The connection dropped before the request ran. Try again.",
});
export const ACTION_REJECTED_FALLBACK_TEXT = "That request could not run.";

export const ACTION = {
  CONNECTION_CHANGED: "connection_changed",
  CAPTURE_STARTED: "capture_started",
  CAPTURE_FAILED: "capture_failed",
  NOTICE_SHOWN: "notice_shown",
  SERVER_MESSAGE: "server_message",
  TYPED_QUESTION_SUBMITTED: "typed_question_submitted",
  RESPONSE_ACTION_SENT: "response_action_sent",
  PAUSE_CHANGED: "pause_changed",
  AUDIO_CHUNK_DROPPED: "audio_chunk_dropped",
};

export const connectionChanged = (connection) => ({
  type: ACTION.CONNECTION_CHANGED,
  connection,
});
export const captureStarted = () => ({ type: ACTION.CAPTURE_STARTED });
export const captureFailed = (message) => ({ type: ACTION.CAPTURE_FAILED, message });
// A transient status (e.g. "Connection unavailable") shown until the next
// lifecycle change clears it.
export const noticeShown = (notice) => ({ type: ACTION.NOTICE_SHOWN, notice });
export const serverMessageReceived = (message) => ({
  type: ACTION.SERVER_MESSAGE,
  message,
});
export const typedQuestionSubmitted = (question) => ({
  type: ACTION.TYPED_QUESTION_SUBMITTED,
  question,
});
// The candidate asked to regenerate/shorten/expand/clarify the suggestion.
export const responseActionSent = (actionType) => ({
  type: ACTION.RESPONSE_ACTION_SENT,
  actionType,
});
export const pauseChanged = (paused) => ({ type: ACTION.PAUSE_CHANGED, paused });
export const audioChunkDropped = () => ({ type: ACTION.AUDIO_CHUNK_DROPPED });

export function deriveStatus(state) {
  if (state.captureError) return STATUS.CAPTURE_FAILED;
  switch (state.connection) {
    case CONNECTION.FAILED:
      return STATUS.FAILED_TO_CONNECT;
    case CONNECTION.ERROR:
      return STATUS.CONNECTION_ERROR;
    case CONNECTION.CLOSED:
      return STATUS.DISCONNECTED;
    case CONNECTION.CONNECTING:
      return STATUS.CONNECTING;
    case CONNECTION.RECONNECTING:
      return STATUS.RECONNECTING;
    case CONNECTION.LOST:
      return STATUS.CONNECTION_LOST;
    case CONNECTION.REVOKED:
      return STATUS.DEVICE_REVOKED;
    default:
      break;
  }
  if (state.isPaused) {
    return state.notice === STATUS.PAUSED_TYPED_QUESTION
      ? STATUS.PAUSED_TYPED_QUESTION
      : STATUS.PAUSED;
  }
  if (state.notice) return state.notice;
  if (state.generation === GENERATION.BUDGET_REACHED) return STATUS.BUDGET_REACHED;
  if (state.modelUnavailable) return STATUS.MODEL_UNAVAILABLE;
  if (state.pendingAction) return STATUS.THINKING;
  // Streaming still means "the answer is being prepared".
  if (state.generation === GENERATION.THINKING) return STATUS.THINKING;
  if (state.generation === GENERATION.STREAMING) return STATUS.THINKING;
  if (state.generation === GENERATION.FAILED) return STATUS.GUIDANCE_UNAVAILABLE;
  return state.isCapturing ? STATUS.LISTENING : STATUS.CONNECTED;
}

// The server bounds interim text to 500 characters; the client keeps the
// newest part if a server sends more.
export const MAX_INTERIM_CHARS = 500;
const NO_INTERIM = Object.freeze({ candidate: "", interviewer: "" });
const ROLE_BY_SPEAKER = Object.freeze({ you: "candidate", caller: "interviewer" });

const baseState = {
  connection: CONNECTION.CONNECTING,
  isCapturing: false,
  captureError: "",
  notice: null,
  generation: GENERATION.IDLE,
  modelUnavailable: false,
  transcript: [],
  nextTranscriptId: 1,
  // In-progress speech (opt-in `interim` capability): at most one line per
  // speaker, replaced by that speaker's final transcript. Display-only.
  interim: NO_INTERIM,
  currentQuestion: "",
  suggestion: "",
  model: null,
  isThinking: false,
  // Streamed generations (opt-in `stream` capability): the ID of the current
  // generation, and whether `suggestion` is still-growing partial text.
  generationId: null,
  isStreaming: false,
  // Response actions: the kind of the shown suggestion ("answer", "shorten",
  // …), the ID of the completed generation it came from (the only one an
  // action may target), the action sent but not yet started by the server,
  // and the explanation of the last rejected action.
  generationKind: null,
  finalGenerationId: null,
  pendingAction: null,
  actionError: "",
  isPaused: false,
  droppedAudioChunks: 0,
  // Resumable sessions: the server session ID and the highest `seq` applied,
  // so messages replayed after a reconnect are applied exactly once.
  sessionId: null,
  lastSeq: 0,
};

export const initialConversationState = Object.freeze({
  ...baseState,
  status: deriveStatus(baseState),
});

// Matches the previous DOM `textContent` assignment: null/undefined render as
// empty text and anything else is stringified.
function toTranscriptText(value) {
  return value == null ? "" : String(value);
}

function appendTranscript(state, role, text) {
  const transcript = [
    ...state.transcript,
    { id: state.nextTranscriptId, role, text: toTranscriptText(text) },
  ];
  return {
    ...state,
    transcript:
      transcript.length > MAX_TRANSCRIPT_ENTRIES
        ? transcript.slice(-MAX_TRANSCRIPT_ENTRIES)
        : transcript,
    nextTranscriptId: state.nextTranscriptId + 1,
  };
}

function toSuggestionText(text) {
  return typeof text === "string" ? text : "";
}

function toModelName(value) {
  return typeof value === "string" && value
    ? value.slice(0, MAX_MODEL_NAME_CHARS)
    : null;
}

// Additive `model: { selected, actual }` metadata on replies. Anything that
// does not match the documented shape is ignored.
function toModelInfo(model) {
  if (!model || typeof model !== "object") return null;
  const selected = toModelName(model.selected);
  if (!selected) return null;
  if (model.actual != null && typeof model.actual !== "string") return null;
  return { selected, actual: toModelName(model.actual) };
}

// Server message handlers run in this fixed order on every incoming message.
// One message can carry several fields; later handlers see earlier results.
// Streamed generations are keyed by generation ID (see applyGenerationDelta).
function withInterim(state, role, text) {
  if (state.interim[role] === text) return state;
  return { ...state, interim: { ...state.interim, [role]: text } };
}

function clearInterim(state) {
  return state.interim === NO_INTERIM ? state : { ...state, interim: NO_INTERIM };
}

function toInterimText(text) {
  const trimmed = text.trim();
  return trimmed.length > MAX_INTERIM_CHARS
    ? trimmed.slice(-MAX_INTERIM_CHARS).trimStart()
    : trimmed;
}

// `{ interim: { speaker, text } }` replaces that speaker's in-progress line;
// empty text clears it. Nothing is shown while paused, since no new audio
// is being sent and late interim text would look like live speech.
function applyInterim(state, message) {
  const { interim } = message;
  if (!interim || typeof interim !== "object") return state;
  const role = Object.hasOwn(ROLE_BY_SPEAKER, interim.speaker ?? "")
    ? ROLE_BY_SPEAKER[interim.speaker]
    : null;
  if (!role || typeof interim.text !== "string") return state;
  if (state.isPaused) return state;
  return withInterim(state, role, toInterimText(interim.text));
}

function applyTranscript(state, message) {
  const role = Object.hasOwn(ROLE_BY_SPEAKER, message.speaker ?? "")
    ? ROLE_BY_SPEAKER[message.speaker]
    : null;
  if (!role) return state;
  // The final transcript replaces the speaker's in-progress line.
  const next = withInterim(appendTranscript(state, role, message.transcript), role, "");
  if (role !== "interviewer") return next;
  // Latest question wins: the newest interviewer utterance replaces the
  // displayed question regardless of any in-flight guidance.
  return { ...next, currentQuestion: message.transcript };
}

// Generation messages from streaming-capable servers carry `generation.id`;
// legacy messages (and introductory replies) have none.
function hasGenerationId(message) {
  return !!message.generation && Object.hasOwn(message.generation, "id");
}

// A message tagged with a generation ID only applies to the current
// generation; anything else is stale (superseded) and ignored.
function isForCurrentGeneration(state, message) {
  if (!hasGenerationId(message)) return true;
  const { id } = message.generation;
  return typeof id === "string" && id !== "" && id === state.generationId;
}

function toGenerationKind(kind) {
  return GENERATION_KINDS.includes(kind) ? kind : null;
}

function applyGenerationResult(state, message) {
  const failed = message.generation?.state === "failed";
  if (!failed && !message.ai_reply) return state;
  if (!isForCurrentGeneration(state, message)) return state;
  // A tagged terminal message completes its generation exactly once; a
  // duplicate for the same ID no longer matches and is ignored.
  const tagged = hasGenerationId(message);
  const generationId = tagged ? null : state.generationId;
  if (failed) {
    // Terminal for this question: transcription keeps running. Any partial
    // streamed text is discarded, and there is no suggestion to act on.
    return {
      ...state,
      suggestion: GUIDANCE_UNAVAILABLE_TEXT,
      model: null,
      isThinking: false,
      isStreaming: false,
      generationId,
      generation: GENERATION.FAILED,
      finalGenerationId: null,
      pendingAction: null,
      notice: null,
    };
  }
  // The final reply replaces any streamed text. Only a reply that names its
  // generation (not the introductory suggestion) can be acted on.
  return {
    ...state,
    suggestion: toSuggestionText(message.ai_reply),
    model: toModelInfo(message.model),
    isThinking: false,
    isStreaming: false,
    generationId,
    generation: GENERATION.IDLE,
    generationKind: tagged
      ? toGenerationKind(message.generation.kind) ?? state.generationKind
      : null,
    finalGenerationId: tagged ? message.generation.id : null,
    pendingAction: null,
    notice: null,
  };
}

function applyGenerationThinking(state, message) {
  if (message.generation?.state !== "thinking") return state;
  const { id, kind } = message.generation;
  // Clear the previous suggestion so stale guidance is never presented as the
  // answer to the question now being generated.
  return {
    ...state,
    suggestion: "",
    model: null,
    isThinking: true,
    isStreaming: false,
    generationId: typeof id === "string" && id ? id : null,
    generation: GENERATION.THINKING,
    generationKind: toGenerationKind(kind),
    finalGenerationId: null,
    pendingAction: null,
    actionError: "",
    notice: null,
  };
}

function applyGenerationDelta(state, message) {
  if (message.generation?.state !== "streaming") return state;
  if (typeof message.delta !== "string" || !message.delta) return state;
  // Deltas must name the current generation, and only extend one that is
  // still in progress (never one that already completed or failed).
  if (!hasGenerationId(message) || !isForCurrentGeneration(state, message)) return state;
  if (state.generation !== GENERATION.THINKING && state.generation !== GENERATION.STREAMING) {
    return state;
  }
  const base = state.isStreaming ? state.suggestion : "";
  return {
    ...state,
    suggestion: (base + message.delta).slice(0, MAX_STREAMED_SUGGESTION_CHARS),
    model: null,
    isThinking: false,
    isStreaming: true,
    generation: GENERATION.STREAMING,
    notice: null,
  };
}

function applyServerError(state, message) {
  if (message.error === "interview_budget_reached") {
    return {
      ...state,
      suggestion: BUDGET_REACHED_TEXT,
      model: null,
      isThinking: false,
      isStreaming: false,
      generationId: null,
      generation: GENERATION.BUDGET_REACHED,
      finalGenerationId: null,
      pendingAction: null,
    };
  }
  if (message.error === "action_rejected") {
    const reason = typeof message.reason === "string" ? message.reason : "";
    return {
      ...state,
      pendingAction: null,
      actionError: Object.hasOwn(ACTION_REJECTION_TEXT, reason)
        ? ACTION_REJECTION_TEXT[reason]
        : ACTION_REJECTED_FALLBACK_TEXT,
      // The server no longer accepts actions on this suggestion.
      finalGenerationId: reason === "stale_generation" ? null : state.finalGenerationId,
    };
  }
  if (message.error === "unsupported_model") {
    // A rejected context, unrelated to any in-flight generation. The server
    // kept the previous context, so later replies (if any) still show.
    return { ...state, modelUnavailable: true };
  }
  return state;
}

const IDLE_GENERATION = {
  isThinking: false,
  isStreaming: false,
  generationId: null,
  generation: GENERATION.IDLE,
  pendingAction: null,
};

function isGenerationInProgress(state) {
  return state.generation === GENERATION.THINKING || state.generation === GENERATION.STREAMING;
}

/**
 * Whether the response actions (regenerate, shorten, expand, clarify) can
 * run: a completed suggestion from a live generation is shown, nothing is
 * being generated or requested, the session is live and not paused, and the
 * interview budget is not spent.
 */
export function canRequestResponseAction(state) {
  return (
    state.connection === CONNECTION.OPEN &&
    !state.isPaused &&
    !!state.finalGenerationId &&
    !state.pendingAction &&
    !isGenerationInProgress(state) &&
    state.generation !== GENERATION.BUDGET_REACHED
  );
}

// `{ session: { id } }` names the server session (resume-capable servers).
// A different ID means the old session expired and a new one started: its
// sequence restarts, and any generation the old session had in flight will
// never complete.
function applySession(state, message) {
  const id = message.session?.id;
  if (typeof id !== "string" || !id || id === state.sessionId) return state;
  const replaced = state.sessionId !== null;
  const restarted = replaced && isGenerationInProgress(state);
  return {
    ...state,
    ...(restarted ? IDLE_GENERATION : {}),
    interim: replaced ? NO_INTERIM : state.interim,
    // The new session knows none of the old generation IDs.
    finalGenerationId: replaced ? null : state.finalGenerationId,
    pendingAction: replaced ? null : state.pendingAction,
    sessionId: id,
    lastSeq: 0,
  };
}

function applyNotice(state, message) {
  if (message.notice !== "audio_gap") return state;
  return { ...state, notice: STATUS.AUDIO_GAP };
}

const SERVER_MESSAGE_HANDLERS = [
  applySession,
  applyInterim,
  applyTranscript,
  applyGenerationResult,
  applyGenerationThinking,
  applyGenerationDelta,
  applyServerError,
  applyNotice,
];

// Sequenced messages (resume-capable sessions) at or below the last applied
// `seq` are replays this client already has; they are ignored.
function applySequence(state, message) {
  if (!Number.isSafeInteger(message.seq)) return state;
  if (message.seq <= state.lastSeq) return null;
  return { ...state, lastSeq: message.seq };
}

export function applyServerMessage(state, message) {
  if (!message || typeof message !== "object") return state;
  const sequenced = applySequence(state, message);
  if (sequenced === null) return state;
  return SERVER_MESSAGE_HANDLERS.reduce(
    (current, handler) => handler(current, message),
    sequenced
  );
}

function reduceFacts(state, action) {
  switch (action?.type) {
    case ACTION.CONNECTION_CHANGED:
      // Any connection change (stop, drop, reconnect) ends in-progress speech
      // lines: their final transcripts, if any, arrive as committed messages.
      // Once reconnection gives up, an in-flight generation can never finish.
      if (isTerminalConnection(action.connection) && isGenerationInProgress(state)) {
        return {
          ...state,
          ...IDLE_GENERATION,
          interim: NO_INTERIM,
          suggestion: "",
          finalGenerationId: null,
          connection: action.connection,
          notice: null,
        };
      }
      // A requested action that had not started yet is answered (rejected or
      // failed) by the resume replay, or never: stop waiting for it.
      return {
        ...clearInterim(state),
        connection: action.connection,
        pendingAction: null,
        finalGenerationId: isTerminalConnection(action.connection) ? null : state.finalGenerationId,
        notice: null,
      };
    case ACTION.CAPTURE_STARTED:
      return { ...state, isCapturing: true, notice: null };
    case ACTION.CAPTURE_FAILED:
      // Capture ended: the session is stopped, so no speech is in progress.
      return {
        ...clearInterim(state),
        isCapturing: false,
        captureError: action.message || STATUS.CAPTURE_FAILED,
      };
    case ACTION.NOTICE_SHOWN:
      return { ...state, notice: action.notice };
    case ACTION.SERVER_MESSAGE:
      return applyServerMessage(state, action.message);
    case ACTION.TYPED_QUESTION_SUBMITTED:
      return {
        ...state,
        currentQuestion: action.question,
        suggestion: "",
        model: null,
        isThinking: true,
        // Until the server names the new generation, deltas still in flight
        // for the previous one must not reappear.
        isStreaming: false,
        generationId: null,
        generation: GENERATION.THINKING,
        generationKind: null,
        finalGenerationId: null,
        pendingAction: null,
        actionError: "",
        notice: null,
      };
    case ACTION.RESPONSE_ACTION_SENT:
      // The shown suggestion stays until the server's `thinking` for the new
      // generation replaces it (or a rejection explains why it did not run).
      return { ...state, pendingAction: action.actionType, actionError: "", notice: null };
    case ACTION.PAUSE_CHANGED:
      return {
        ...(action.paused ? clearInterim(state) : state),
        isPaused: action.paused,
        notice: null,
      };
    case ACTION.AUDIO_CHUNK_DROPPED: {
      const droppedAudioChunks = state.droppedAudioChunks + 1;
      const reportCongestion =
        droppedAudioChunks === 1 ||
        droppedAudioChunks % DROPPED_CHUNK_STATUS_INTERVAL === 0;
      return {
        ...state,
        droppedAudioChunks,
        notice: reportCongestion ? STATUS.SLOW_CONNECTION : state.notice,
      };
    }
    default:
      return state;
  }
}

export function conversationReducer(state, action) {
  const next = reduceFacts(state, action);
  if (next === state) return state;
  const status = deriveStatus(next);
  return status === next.status ? next : { ...next, status };
}
