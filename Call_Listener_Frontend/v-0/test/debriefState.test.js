import { describe, expect, it } from "vitest";
import {
  CLIENT_DEBRIEF_REASON,
  DEBRIEF,
  debriefDiscarded,
  debriefReceived,
  debriefReducer,
  debriefRequested,
  DEFAULT_DEBRIEF_REASON_TEXT,
  describeDebriefReason,
  followUpDraftEdited,
  initialDebriefState,
  MAX_FOLLOW_UP_DRAFT_CHARS,
  normalizeReview,
} from "../src/services/debriefState.js";
import { CLIENT_CAPABILITIES, encodeEndMessage } from "../src/services/interviewMessages.js";

const REVIEW = {
  questionsCovered: [
    { question: "Why this team?", candidateAnswerSummary: "You named the platform work.", evidenceUsed: ["evidence-1"] },
  ],
  strengths: ["Clear motivation."],
  improvementTopics: [{ topic: "Examples", why: "No example given.", practiceSuggestion: "Prepare one story." }],
  followUpDraft: "Thank you for your time.",
};

const run = (...actions) => actions.reduce(debriefReducer, initialDebriefState);

describe("debrief message shape", () => {
  it("advertises the debrief capability and keeps the plain end unchanged", () => {
    expect(CLIENT_CAPABILITIES).toContain("debrief");
    expect(JSON.parse(encodeEndMessage())).toEqual({ end: true });
    expect(JSON.parse(encodeEndMessage({ debrief: false }))).toEqual({ end: true });
    expect(JSON.parse(encodeEndMessage({ debrief: true }))).toEqual({ end: { debrief: true } });
    expect(JSON.parse(encodeEndMessage({ debrief: "yes" }))).toEqual({ end: true });
  });
});

describe("debriefReducer", () => {
  it("starts idle and moves to preparing on request", () => {
    expect(initialDebriefState.status).toBe(DEBRIEF.IDLE);
    expect(run(debriefRequested()).status).toBe(DEBRIEF.PREPARING);
  });

  it("becomes ready with the review and an editable copy of the follow-up draft", () => {
    const state = run(debriefRequested(), debriefReceived({ status: "ready", review: REVIEW }));
    expect(state.status).toBe(DEBRIEF.READY);
    expect(state.review.questionsCovered[0]).toEqual({ id: "question-1", ...REVIEW.questionsCovered[0] });
    expect(state.followUpDraft).toBe("Thank you for your time.");

    const edited = debriefReducer(state, followUpDraftEdited("Thanks, Sam!"));
    expect(edited.followUpDraft).toBe("Thanks, Sam!");
    expect(edited.review.followUpDraft).toBe("Thank you for your time.");
    const bounded = debriefReducer(state, followUpDraftEdited("x".repeat(MAX_FOLLOW_UP_DRAFT_CHARS + 10)));
    expect(bounded.followUpDraft).toHaveLength(MAX_FOLLOW_UP_DRAFT_CHARS);
  });

  it.each([
    [{ status: "failed", reason: "generation_failed" }, DEBRIEF.FAILED, "generation_failed"],
    [{ status: "skipped", reason: "budget_reached" }, DEBRIEF.SKIPPED, "budget_reached"],
    [{ status: "skipped", reason: "empty_transcript" }, DEBRIEF.SKIPPED, "empty_transcript"],
    [{ status: "failed", reason: CLIENT_DEBRIEF_REASON.NO_RESPONSE }, DEBRIEF.FAILED, "no_response"],
    [{ status: "ready", review: "not a review" }, DEBRIEF.FAILED, CLIENT_DEBRIEF_REASON.INVALID_REVIEW],
    [{ status: "weird" }, DEBRIEF.FAILED, CLIENT_DEBRIEF_REASON.INVALID_REVIEW],
    [null, DEBRIEF.FAILED, CLIENT_DEBRIEF_REASON.INVALID_REVIEW],
  ])("reports %j as %s", (payload, status, reason) => {
    const state = run(debriefRequested(), debriefReceived(payload));
    expect(state.status).toBe(status);
    expect(state.reason).toBe(reason);
    expect(state.review).toBeNull();
  });

  it("ignores answers that were not requested or arrive late", () => {
    expect(run(debriefReceived({ status: "ready", review: REVIEW }))).toEqual(initialDebriefState);
    const ready = run(debriefRequested(), debriefReceived({ status: "ready", review: REVIEW }));
    expect(debriefReducer(ready, debriefReceived({ status: "failed", reason: "timeout" }))).toBe(ready);
    expect(debriefReducer(ready, debriefRequested())).toBe(ready);
    expect(run(followUpDraftEdited("x"))).toEqual(initialDebriefState);
  });

  it("forgets everything on discard", () => {
    const ready = run(debriefRequested(), debriefReceived({ status: "ready", review: REVIEW }));
    expect(debriefReducer(ready, debriefDiscarded())).toEqual(initialDebriefState);
  });
});

describe("review normalization", () => {
  it("bounds and cleans what the server sent", () => {
    const review = normalizeReview({
      questionsCovered: [
        { question: "  Q1  ", candidateAnswerSummary: 42, evidenceUsed: ["evidence-1", 7, ""] },
        { question: "" },
        "junk",
      ],
      strengths: ["Same", "Same", 5, "Other"],
      improvementTopics: [{ topic: "T", why: null }],
      followUpDraft: { not: "text" },
      score: 10,
    });
    expect(review).toEqual({
      questionsCovered: [{ id: "question-1", question: "Q1", candidateAnswerSummary: "", evidenceUsed: ["evidence-1"] }],
      strengths: ["Same", "Other"],
      improvementTopics: [{ id: "topic-1", topic: "T", why: "", practiceSuggestion: "" }],
      followUpDraft: "",
    });
    const many = normalizeReview({ strengths: Array.from({ length: 50 }, (_, index) => "s" + index) });
    expect(many.strengths.length).toBeLessThanOrEqual(20);
  });

  it("explains every reason in candidate-facing text", () => {
    expect(describeDebriefReason("budget_reached")).toMatch(/budget/);
    expect(describeDebriefReason("disconnected")).toMatch(/connection closed/);
    expect(describeDebriefReason("toString")).toBe(DEFAULT_DEBRIEF_REASON_TEXT);
  });
});

describe("self-review notes", () => {
  it("are editable once a result arrives, bounded, kept across the result, and cleared on discard", async () => {
    const {
      debriefDiscarded,
      debriefReceived,
      debriefReducer,
      debriefRequested,
      initialDebriefState,
      MAX_SELF_REVIEW_NOTES_CHARS,
      selfReviewNotesEdited,
    } = await import("../src/services/debriefState.js");
    const preparing = debriefReducer(initialDebriefState, debriefRequested());
    expect(debriefReducer(preparing, selfReviewNotesEdited("early"))).toBe(preparing);
    const skipped = debriefReducer(preparing, debriefReceived({ status: "skipped", reason: "budget_reached" }));
    const noted = debriefReducer(skipped, selfReviewNotesEdited("x".repeat(MAX_SELF_REVIEW_NOTES_CHARS + 10)));
    expect(noted.selfReviewNotes).toHaveLength(MAX_SELF_REVIEW_NOTES_CHARS);
    expect(debriefReducer(noted, debriefDiscarded()).selfReviewNotes).toBe("");
    expect(debriefReducer(initialDebriefState, selfReviewNotesEdited("idle"))).toBe(initialDebriefState);
  });
});
