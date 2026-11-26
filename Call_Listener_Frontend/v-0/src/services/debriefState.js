// Pure state for the unsaved end-of-interview debrief ("Stop and review").
// The review lives only in this reducer: it is never written to storage and
// is gone once the candidate discards it or leaves the page.
//
// Server answer: `{ debrief: { status: "ready", review } }` or
// `{ debrief: { status: "failed" | "skipped", reason } }`
// (see docs/protocols/websocket.md).

export const DEBRIEF = Object.freeze({
  IDLE: "idle",
  PREPARING: "preparing",
  READY: "ready",
  FAILED: "failed",
  SKIPPED: "skipped",
});

// Client-side reasons, next to the server's.
export const CLIENT_DEBRIEF_REASON = Object.freeze({
  NO_RESPONSE: "no_response",
  DISCONNECTED: "disconnected",
  CANCELLED: "cancelled",
  INVALID_REVIEW: "invalid_review",
});

export const DEBRIEF_REASON_TEXT = Object.freeze({
  budget_reached: "The interview's model budget is spent, so no review was generated.",
  empty_transcript: "Nothing was transcribed in this interview, so there is nothing to review.",
  generation_failed: "The review could not be generated.",
  invalid_output: "The review could not be generated.",
  timeout: "Preparing the review took too long and was cancelled.",
  no_response: "The server did not send a review. It may not support reviews yet.",
  disconnected: "The connection closed before the review was ready.",
  cancelled: "The review was cancelled.",
  invalid_review: "The review the server sent could not be read.",
});

export const DEFAULT_DEBRIEF_REASON_TEXT = "The review is unavailable.";

export function describeDebriefReason(reason) {
  return Object.hasOwn(DEBRIEF_REASON_TEXT, reason) ? DEBRIEF_REASON_TEXT[reason] : DEFAULT_DEBRIEF_REASON_TEXT;
}

// Client-side bounds, generous next to the server's, so a misbehaving server
// cannot grow state without limit.
const LIMITS = Object.freeze({
  items: 20,
  text: 2_000,
  evidence: 5,
  evidenceId: 32,
  followUp: 4_000,
  reason: 64,
});

// The editable follow-up draft can grow while the candidate types.
export const MAX_FOLLOW_UP_DRAFT_CHARS = 8_000;
// The candidate's own self-review notes; held only in memory like the review.
export const MAX_SELF_REVIEW_NOTES_CHARS = 8_000;

function text(value, max = LIMITS.text) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function list(value, mapItem) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, LIMITS.items).map((item, index) => mapItem(item, index)).filter(Boolean);
}

// Each item gets a local `id` so the UI has stable keys even when two items
// share the same text.
function normalizeQuestion(item, index) {
  const question = text(item?.question);
  if (!question) return null;
  const evidenceUsed = Array.isArray(item.evidenceUsed)
    ? item.evidenceUsed.map((id) => text(id, LIMITS.evidenceId)).filter(Boolean).slice(0, LIMITS.evidence)
    : [];
  return { id: "question-" + String(index + 1), question, candidateAnswerSummary: text(item.candidateAnswerSummary), evidenceUsed };
}

function normalizeTopic(item, index) {
  const topic = text(item?.topic);
  if (!topic) return null;
  return { id: "topic-" + String(index + 1), topic, why: text(item.why), practiceSuggestion: text(item.practiceSuggestion) };
}

/** Validate and bound a review; returns null when it is not a review at all. */
export function normalizeReview(review) {
  if (!review || typeof review !== "object" || Array.isArray(review)) return null;
  return {
    questionsCovered: list(review.questionsCovered, normalizeQuestion),
    // Duplicates are dropped: each strength is its own key.
    strengths: [...new Set(list(review.strengths, (item) => text(item) || null))],
    improvementTopics: list(review.improvementTopics, normalizeTopic),
    followUpDraft: text(review.followUpDraft, LIMITS.followUp),
  };
}

/** Turn the server's `debrief` object (or a client-side failure) into a result. */
export function parseDebriefPayload(payload) {
  const status = payload?.status;
  if (status === DEBRIEF.READY) {
    const review = normalizeReview(payload.review);
    return review
      ? { status: DEBRIEF.READY, review }
      : { status: DEBRIEF.FAILED, reason: CLIENT_DEBRIEF_REASON.INVALID_REVIEW };
  }
  if (status === DEBRIEF.FAILED || status === DEBRIEF.SKIPPED) {
    return { status, reason: text(payload.reason, LIMITS.reason) };
  }
  return { status: DEBRIEF.FAILED, reason: CLIENT_DEBRIEF_REASON.INVALID_REVIEW };
}

export const initialDebriefState = Object.freeze({
  status: DEBRIEF.IDLE,
  review: null,
  followUpDraft: "",
  selfReviewNotes: "",
  reason: "",
});

export const debriefRequested = () => ({ type: "debrief/requested" });
export const debriefReceived = (payload) => ({ type: "debrief/received", payload });
export const followUpDraftEdited = (value) => ({ type: "debrief/followUpEdited", value });
export const selfReviewNotesEdited = (value) => ({ type: "debrief/notesEdited", value });
export const debriefDiscarded = () => ({ type: "debrief/discarded" });

/** Notes can be written once the review screen has a result, even without an AI review. */
export function canWriteSelfReview(status) {
  return status === DEBRIEF.READY || status === DEBRIEF.FAILED || status === DEBRIEF.SKIPPED;
}

export function debriefReducer(state = initialDebriefState, action) {
  switch (action?.type) {
    case "debrief/requested":
      if (state.status !== DEBRIEF.IDLE) return state;
      return { ...initialDebriefState, status: DEBRIEF.PREPARING };
    case "debrief/received": {
      // Only the pending request can be answered; late answers are ignored.
      if (state.status !== DEBRIEF.PREPARING) return state;
      const result = parseDebriefPayload(action.payload);
      if (result.status === DEBRIEF.READY) {
        return {
          status: DEBRIEF.READY,
          review: result.review,
          followUpDraft: result.review.followUpDraft,
          selfReviewNotes: "",
          reason: "",
        };
      }
      return { ...initialDebriefState, status: result.status, reason: result.reason };
    }
    case "debrief/followUpEdited":
      if (state.status !== DEBRIEF.READY) return state;
      return { ...state, followUpDraft: String(action.value ?? "").slice(0, MAX_FOLLOW_UP_DRAFT_CHARS) };
    case "debrief/notesEdited":
      if (!canWriteSelfReview(state.status)) return state;
      return { ...state, selfReviewNotes: String(action.value ?? "").slice(0, MAX_SELF_REVIEW_NOTES_CHARS) };
    case "debrief/discarded":
      return initialDebriefState;
    default:
      return state;
  }
}
