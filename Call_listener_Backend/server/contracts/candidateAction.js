import { z } from "zod";

/**
 * Candidate response actions on the live suggestion. Each one starts a new
 * generation for the current interviewer question (see StreamManager).
 */
export const CANDIDATE_ACTION_TYPES = Object.freeze(["regenerate", "shorten", "expand", "clarify"]);

/** Every `generation.kind` the server reports: a normal answer or an action. */
export const GENERATION_KINDS = Object.freeze(["answer", ...CANDIDATE_ACTION_TYPES]);

/** Reasons sent with `{ error: "action_rejected", reason }`. */
export const ACTION_REJECTION = Object.freeze({
  STALE_GENERATION: "stale_generation",
  NO_FINAL_ANSWER: "no_final_answer",
  RATE_LIMITED: "rate_limited",
  QUESTION_LIMIT_REACHED: "question_limit_reached",
});

// Generation IDs are short server-issued strings (`g<n>`); anything longer is
// not one of ours, so the bound only has to be generous.
const MAX_GENERATION_ID_CHARS = 64;

const CandidateActionSchema = z.object({
  action: z.object({
    type: z.enum(CANDIDATE_ACTION_TYPES),
    generationId: z.string().min(1).max(MAX_GENERATION_ID_CHARS),
  }).strict(),
});

/** Whether a parsed client frame is an action command at all. */
export function isCandidateActionFrame(message) {
  return !!message && typeof message === "object" && Object.hasOwn(message, "action");
}

/**
 * Validate an `{ action: { type, generationId } }` frame. Returns the action
 * or null when it is malformed (unknown type, missing or oversized ID, or
 * extra fields).
 */
export function parseCandidateAction(message) {
  const result = CandidateActionSchema.safeParse(message);
  return result.success ? result.data.action : null;
}
