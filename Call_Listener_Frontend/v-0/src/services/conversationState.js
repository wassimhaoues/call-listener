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
};

export const CONNECTION = {
  CONNECTING: "connecting",
  OPEN: "open",
  CLOSED: "closed",
  ERROR: "error",
  FAILED: "failed",
};

const GENERATION = {
  IDLE: "idle",
  THINKING: "thinking",
  FAILED: "failed",
  BUDGET_REACHED: "budget_reached",
};

export const GUIDANCE_UNAVAILABLE_TEXT =
  "Guidance is unavailable right now. Transcription remains active.";
export const BUDGET_REACHED_TEXT =
  "Interview model budget reached. Suggestions are paused.";
export const UNSUPPORTED_MODEL_TEXT =
  "The AI model chosen in Interview Settings isn't available. Stop the session, pick another model in Interview Settings, and start again.";

// Bound the rendered transcript so a long interview cannot grow the DOM and
// state without limit. The newest entries are kept.
export const MAX_TRANSCRIPT_ENTRIES = 500;
const MAX_MODEL_NAME_CHARS = 160;

// Report congestion on the first dropped chunk and then every Nth one, so the
// status line does not flicker on every 20 ms batch.
const DROPPED_CHUNK_STATUS_INTERVAL = 25;

export const ACTION = {
  CONNECTION_CHANGED: "connection_changed",
  CAPTURE_STARTED: "capture_started",
  CAPTURE_FAILED: "capture_failed",
  NOTICE_SHOWN: "notice_shown",
  SERVER_MESSAGE: "server_message",
  TYPED_QUESTION_SUBMITTED: "typed_question_submitted",
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
  if (state.generation === GENERATION.THINKING) return STATUS.THINKING;
  if (state.generation === GENERATION.FAILED) return STATUS.GUIDANCE_UNAVAILABLE;
  return state.isCapturing ? STATUS.LISTENING : STATUS.CONNECTED;
}

const baseState = {
  connection: CONNECTION.CONNECTING,
  isCapturing: false,
  captureError: "",
  notice: null,
  generation: GENERATION.IDLE,
  modelUnavailable: false,
  transcript: [],
  nextTranscriptId: 1,
  currentQuestion: "",
  suggestion: "",
  model: null,
  isThinking: false,
  isPaused: false,
  droppedAudioChunks: 0,
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
// New message kinds (e.g. streamed generations keyed by generation ID) slot in
// as additional handlers without changing the socket hook.
function applyTranscript(state, message) {
  let next = state;
  if (message.speaker === "you") {
    next = appendTranscript(next, "candidate", message.transcript);
  }
  if (message.speaker === "caller") {
    next = appendTranscript(next, "interviewer", message.transcript);
    // Latest question wins: the newest interviewer utterance replaces the
    // displayed question regardless of any in-flight guidance.
    next = { ...next, currentQuestion: message.transcript };
  }
  return next;
}

function applyGenerationResult(state, message) {
  if (message.generation?.state === "failed") {
    // Terminal for this question: transcription keeps running.
    return {
      ...state,
      suggestion: GUIDANCE_UNAVAILABLE_TEXT,
      model: null,
      isThinking: false,
      generation: GENERATION.FAILED,
      notice: null,
    };
  }
  if (message.ai_reply) {
    return {
      ...state,
      suggestion: toSuggestionText(message.ai_reply),
      model: toModelInfo(message.model),
      isThinking: false,
      generation: GENERATION.IDLE,
      notice: null,
    };
  }
  return state;
}

function applyGenerationThinking(state, message) {
  if (message.generation?.state !== "thinking") return state;
  // Clear the previous suggestion so stale guidance is never presented as the
  // answer to the question now being generated.
  return {
    ...state,
    suggestion: "",
    model: null,
    isThinking: true,
    generation: GENERATION.THINKING,
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
      generation: GENERATION.BUDGET_REACHED,
    };
  }
  if (message.error === "unsupported_model") {
    // A rejected context, unrelated to any in-flight generation. The server
    // kept the previous context, so later replies (if any) still show.
    return { ...state, modelUnavailable: true };
  }
  return state;
}

const SERVER_MESSAGE_HANDLERS = [
  applyTranscript,
  applyGenerationResult,
  applyGenerationThinking,
  applyServerError,
];

export function applyServerMessage(state, message) {
  if (!message || typeof message !== "object") return state;
  return SERVER_MESSAGE_HANDLERS.reduce(
    (current, handler) => handler(current, message),
    state
  );
}

function reduceFacts(state, action) {
  switch (action?.type) {
    case ACTION.CONNECTION_CHANGED:
      return { ...state, connection: action.connection, notice: null };
    case ACTION.CAPTURE_STARTED:
      return { ...state, isCapturing: true, notice: null };
    case ACTION.CAPTURE_FAILED:
      return {
        ...state,
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
        generation: GENERATION.THINKING,
        notice: null,
      };
    case ACTION.PAUSE_CHANGED:
      return { ...state, isPaused: action.paused, notice: null };
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
