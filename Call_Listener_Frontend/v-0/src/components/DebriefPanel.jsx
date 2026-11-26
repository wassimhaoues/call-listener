import React, { useEffect, useRef, useState } from "react";
import Button from "@/components/ui/Button.jsx";
import { Card, CardBody, CardHeader } from "@/components/ui/Card.jsx";
import { DEBRIEF, describeDebriefReason, MAX_FOLLOW_UP_DRAFT_CHARS } from "@/services/debriefState.js";
import { evidenceLabel } from "@/services/debriefMarkdown.js";

export const NOT_SAVED_TEXT =
  "This review is not saved. Call Listener keeps no copy: it disappears when you discard it or leave this screen. Export it to keep it.";
export const PREPARING_TEXT = "Preparing your review…";

const DISCARD_LABELS = Object.freeze({
  [DEBRIEF.PREPARING]: "Cancel",
  [DEBRIEF.READY]: "Discard",
});

function QuestionsCovered({ questions, evidence }) {
  if (!questions.length) {
    return <p className="mt-1 text-sm text-[var(--text-2)]">No questions were identified.</p>;
  }
  return (
    <ol className="mt-1 space-y-3 text-sm list-decimal pl-5">
      {questions.map((item) => (
        <li key={item.id}>
          <p className="font-medium">{item.question}</p>
          <p className="text-[var(--text-2)]">
            What you said: {item.candidateAnswerSummary || "No answer in the transcript."}
          </p>
          {item.evidenceUsed.length > 0 && (
            <p className="text-xs text-[var(--text-2)]">
              Evidence used: {item.evidenceUsed.map((id) => evidenceLabel(id, evidence)).join("; ")}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}

function Strengths({ strengths }) {
  if (!strengths.length) return <p className="mt-1 text-sm text-[var(--text-2)]">None noted.</p>;
  return (
    <ul className="mt-1 space-y-1 text-sm list-disc pl-5">
      {strengths.map((item) => <li key={item}>{item}</li>)}
    </ul>
  );
}

function ImprovementTopics({ topics }) {
  if (!topics.length) return <p className="mt-1 text-sm text-[var(--text-2)]">None noted.</p>;
  return (
    <ul className="mt-1 space-y-2 text-sm list-disc pl-5">
      {topics.map((item) => (
        <li key={item.id}>
          <p className="font-medium">{item.topic}</p>
          {item.why && <p className="text-[var(--text-2)]">Why: {item.why}</p>}
          {item.practiceSuggestion && <p className="text-[var(--text-2)]">Practice: {item.practiceSuggestion}</p>}
        </li>
      ))}
    </ul>
  );
}

function ReviewBody({ review, evidence, followUpDraft, onFollowUpDraftChange }) {
  return (
    <div className="space-y-5">
      <section>
        <h2 className="text-sm font-semibold">Questions covered</h2>
        <QuestionsCovered evidence={evidence} questions={review.questionsCovered} />
      </section>
      <section>
        <h2 className="text-sm font-semibold">Strengths</h2>
        <Strengths strengths={review.strengths} />
      </section>
      <section>
        <h2 className="text-sm font-semibold">Topics to improve</h2>
        <ImprovementTopics topics={review.improvementTopics} />
      </section>
      <section>
        <h2 className="text-sm font-semibold">
          <label htmlFor="debrief-follow-up">Follow-up draft</label>
        </h2>
        <p className="mt-1 text-xs text-[var(--text-2)]" id="debrief-follow-up-help">
          Edit it freely. It is never sent anywhere; copy it into your own email if you want to use it.
        </p>
        <textarea
          aria-describedby="debrief-follow-up-help"
          className="input mt-2 min-h-32 w-full"
          id="debrief-follow-up"
          maxLength={MAX_FOLLOW_UP_DRAFT_CHARS}
          onChange={(event) => onFollowUpDraftChange(event.target.value)}
          value={followUpDraft}
        />
      </section>
    </div>
  );
}

// The unsaved end-of-interview review. Everything is rendered as plain text
// nodes; nothing from the server is interpreted as HTML.
export default function DebriefPanel({
  state,
  evidence = [],
  onFollowUpDraftChange,
  onExport,
  onDiscard,
}) {
  const [exported, setExported] = useState(false);
  const headingRef = useRef(null);
  const { status } = state;

  // Move focus to the result once it arrives, for keyboard and screen-reader users.
  useEffect(() => {
    if (status !== DEBRIEF.PREPARING) headingRef.current?.focus();
  }, [status]);

  function exportReview() {
    onExport();
    setExported(true);
  }

  const ready = status === DEBRIEF.READY;
  return (
    <Card className="h-full min-h-0 flex flex-col">
      <CardHeader>
        <h1 className="outline-none" ref={headingRef} tabIndex={-1}>Interview review</h1>
      </CardHeader>
      <CardBody className="flex-1 min-h-0 overflow-auto space-y-4">
        <p className="rounded-xl border border-[var(--border)] px-3 py-2 text-sm" role="note">
          {NOT_SAVED_TEXT}
        </p>
        {status === DEBRIEF.PREPARING && (
          <output className="block text-sm text-[var(--text-2)]" aria-live="polite">
            {PREPARING_TEXT}
          </output>
        )}
        {(status === DEBRIEF.FAILED || status === DEBRIEF.SKIPPED) && (
          <p className="text-sm" role="alert">{describeDebriefReason(state.reason)}</p>
        )}
        {ready && (
          <ReviewBody
            evidence={evidence}
            followUpDraft={state.followUpDraft}
            onFollowUpDraftChange={onFollowUpDraftChange}
            review={state.review}
          />
        )}
        {ready && (
          <p className="text-xs text-[var(--text-2)]">
            Generated by AI from the interview transcript. Check it before relying on it.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {ready && (
            <Button onClick={exportReview} type="button">
              Export as Markdown
            </Button>
          )}
          <Button onClick={onDiscard} type="button" variant="ghost">
            {DISCARD_LABELS[status] ?? "Back to setup"}
          </Button>
        </div>
        {exported && (
          <output className="block text-xs text-[var(--text-2)]">
            Export started. The file goes wherever you choose to save it; Call Listener keeps no copy.
          </output>
        )}
      </CardBody>
    </Card>
  );
}
