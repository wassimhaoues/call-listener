import { z } from "zod";

/**
 * The unsaved candidate debrief (InterviewReview) produced at the end of an
 * interview. It is generated once from the session transcript, sent to the
 * client, and never stored: the session is purged right after.
 *
 * Every field is bounded. Over-long model output is clipped rather than
 * rejected so one verbose sentence does not cost the whole review; unknown
 * keys (for example a score) are stripped, because hiring assessments are
 * out of product scope.
 */
export const REVIEW_LIMITS = Object.freeze({
  questions: 12,
  questionChars: 300,
  answerSummaryChars: 600,
  evidencePerQuestion: 3,
  strengths: 5,
  strengthChars: 300,
  improvementTopics: 5,
  topicChars: 120,
  whyChars: 400,
  practiceChars: 400,
  followUpChars: 2_000,
});

/** Debrief outcomes sent as `{ debrief: { status, ... } }`. */
export const DEBRIEF_STATUS = Object.freeze({
  READY: "ready",
  FAILED: "failed",
  SKIPPED: "skipped",
});

/** Reasons for a `failed` or `skipped` debrief. */
export const DEBRIEF_REASON = Object.freeze({
  BUDGET_REACHED: "budget_reached",
  EMPTY_TRANSCRIPT: "empty_transcript",
  GENERATION_FAILED: "generation_failed",
  INVALID_OUTPUT: "invalid_output",
  TIMEOUT: "timeout",
});

const clippedText = (max) => z.string().trim().min(1).transform((value) => value.slice(0, max));

const clippedList = (item, max) => z.array(item).transform((items) => items.slice(0, max));

const QuestionCoveredSchema = z.object({
  question: clippedText(REVIEW_LIMITS.questionChars),
  candidateAnswerSummary: clippedText(REVIEW_LIMITS.answerSummaryChars),
  evidenceUsed: clippedList(z.string(), 10).default([]),
});

const ImprovementTopicSchema = z.object({
  topic: clippedText(REVIEW_LIMITS.topicChars),
  why: clippedText(REVIEW_LIMITS.whyChars),
  practiceSuggestion: clippedText(REVIEW_LIMITS.practiceChars),
});

export const InterviewReviewSchema = z.object({
  questionsCovered: clippedList(QuestionCoveredSchema, REVIEW_LIMITS.questions),
  strengths: clippedList(clippedText(REVIEW_LIMITS.strengthChars), REVIEW_LIMITS.strengths),
  improvementTopics: clippedList(ImprovementTopicSchema, REVIEW_LIMITS.improvementTopics),
  followUpDraft: z.string().trim().transform((value) => value.slice(0, REVIEW_LIMITS.followUpChars)),
});

/**
 * Validate a model's review and keep only evidence IDs the session actually
 * supplied (deduplicated, at most three per question).
 * @returns {{ success: true, review: object } | { success: false, issues: string[] }}
 */
export function parseInterviewReview(value, knownEvidenceIds = []) {
  const result = InterviewReviewSchema.safeParse(value);
  if (!result.success) {
    return {
      success: false,
      issues: result.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".") || "review"}: ${issue.message}`),
    };
  }
  const known = new Set(knownEvidenceIds);
  const review = {
    ...result.data,
    questionsCovered: result.data.questionsCovered.map((item) => ({
      ...item,
      evidenceUsed: [...new Set(item.evidenceUsed)]
        .filter((id) => known.has(id))
        .slice(0, REVIEW_LIMITS.evidencePerQuestion),
    })),
  };
  return { success: true, review };
}

const EndOptionsSchema = z.object({ debrief: z.boolean().optional() }).strict();

/**
 * Parse the `end` member of a client frame. `{ end: true }` (or any other
 * truthy non-object, as before) is a plain end; `{ end: { debrief: true } }`
 * asks for the debrief. A malformed options object returns null.
 * @returns {{ debrief: boolean } | null}
 */
export function parseEndRequest(end) {
  if (!end || typeof end !== "object") return { debrief: false };
  const result = EndOptionsSchema.safeParse(end);
  return result.success ? { debrief: result.data.debrief === true } : null;
}
