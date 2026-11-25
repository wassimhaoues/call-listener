// Pure transcript + generation state for the live interview workspace.
// Every state change flows through `conversationReducer`, so the socket and
// capture hooks only dispatch actions and never own display state.

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
  SLOW_CONNECTION: "Slow connection — limiting audio",
};

export const GUIDANCE_UNAVAILABLE_TEXT =
  "Guidance is unavailable right now. Transcription remains active.";
export const BUDGET_REACHED_TEXT =
  "Interview model budget reached. Suggestions are paused.";

// Report congestion on the first dropped chunk and then every Nth one, so the
// status line does not flicker on every 20 ms batch.
const DROPPED_CHUNK_STATUS_INTERVAL = 25;

export const ACTION = {
  STATUS_CHANGED: "status_changed",
  SERVER_MESSAGE: "server_message",
  TYPED_QUESTION_SUBMITTED: "typed_question_submitted",
  PAUSE_CHANGED: "pause_changed",
  AUDIO_CHUNK_DROPPED: "audio_chunk_dropped",
};

export const initialConversationState = Object.freeze({
  status: STATUS.CONNECTING,
  transcript: [],
  nextTranscriptId: 1,
  currentQuestion: "",
  suggestion: "",
  isThinking: false,
  isPaused: false,
  droppedAudioChunks: 0,
});

export const statusChanged = (status) => ({ type: ACTION.STATUS_CHANGED, status });
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

// Matches the previous DOM `textContent` assignment: null/undefined render as
// empty text and anything else is stringified.
function toTranscriptText(value) {
  return value == null ? "" : String(value);
}

function appendTranscript(state, role, text) {
  return {
    ...state,
    transcript: [
      ...state.transcript,
      { id: state.nextTranscriptId, role, text: toTranscriptText(text) },
    ],
    nextTranscriptId: state.nextTranscriptId + 1,
  };
}

function toSuggestionText(text) {
  return typeof text === "string" ? text : "";
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
      isThinking: false,
      status: STATUS.GUIDANCE_UNAVAILABLE,
    };
  }
  if (message.ai_reply) {
    return {
      ...state,
      suggestion: toSuggestionText(message.ai_reply),
      isThinking: false,
      status: STATUS.LISTENING,
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
    isThinking: true,
    status: STATUS.THINKING,
  };
}

function applyServerError(state, message) {
  if (message.error !== "interview_budget_reached") return state;
  return {
    ...state,
    suggestion: BUDGET_REACHED_TEXT,
    isThinking: false,
    status: STATUS.BUDGET_REACHED,
  };
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

export function conversationReducer(state, action) {
  switch (action?.type) {
    case ACTION.STATUS_CHANGED:
      return { ...state, status: action.status };
    case ACTION.SERVER_MESSAGE:
      return applyServerMessage(state, action.message);
    case ACTION.TYPED_QUESTION_SUBMITTED:
      return {
        ...state,
        currentQuestion: action.question,
        suggestion: "",
        isThinking: true,
        status: STATUS.THINKING,
      };
    case ACTION.PAUSE_CHANGED:
      return {
        ...state,
        isPaused: action.paused,
        status: action.paused ? STATUS.PAUSED : STATUS.LISTENING,
      };
    case ACTION.AUDIO_CHUNK_DROPPED: {
      const droppedAudioChunks = state.droppedAudioChunks + 1;
      const reportCongestion =
        droppedAudioChunks === 1 ||
        droppedAudioChunks % DROPPED_CHUNK_STATUS_INTERVAL === 0;
      return {
        ...state,
        droppedAudioChunks,
        status: reportCongestion ? STATUS.SLOW_CONNECTION : state.status,
      };
    }
    default:
      return state;
  }
}
