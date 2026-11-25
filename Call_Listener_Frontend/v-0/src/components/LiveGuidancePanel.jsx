import React, { useState } from "react";
import SuggestionText from "./SuggestionText.jsx";

export default function LiveGuidancePanel({
  question,
  suggestion,
  evidence = [],
  onSubmitTypedQuestion,
  isThinking = false,
}) {
  const [typedQuestion, setTypedQuestion] = useState("");

  function submitTypedQuestion(event) {
    event.preventDefault();
    const normalizedQuestion = typedQuestion.trim();
    if (!normalizedQuestion) return;
    onSubmitTypedQuestion?.(normalizedQuestion);
    setTypedQuestion("");
  }

  return (
    <div className="space-y-5">
      <section>
        <h2 className="text-sm font-semibold">Current interviewer question</h2>
        <p className="mt-1 text-sm text-[var(--text-2)]">
          {question || "Waiting for an interviewer question…"}
        </p>
      </section>
      <section>
        <h2 className="text-sm font-semibold">Suggested answer</h2>
        <div className="prose prose-sm max-w-none mt-1">
          {isThinking ? (
            <p className="text-[var(--text-2)]" role="status">
              Preparing guidance for this question…
            </p>
          ) : (
            <SuggestionText text={suggestion} />
          )}
        </div>
      </section>
      <section>
        <h2 className="text-sm font-semibold">Relevant experience</h2>
        {evidence.length ? (
          <ul className="mt-1 text-sm space-y-1">
            {evidence.slice(0, 3).map((item) => (
              <li key={`${item.requirement}-${item.evidence}`}>{item.evidence}</li>
            ))}
          </ul>
        ) : <p className="mt-1 text-sm text-[var(--text-2)]">No matched evidence yet.</p>}
      </section>
      {onSubmitTypedQuestion && (
        <section>
          <h2 className="text-sm font-semibold">Type interviewer question</h2>
          <p className="mt-1 text-sm text-[var(--text-2)]">
            System audio is unavailable. Type the question to receive candidate guidance.
          </p>
          <form className="mt-2 flex gap-2" onSubmit={submitTypedQuestion}>
            <input
              aria-label="Interviewer question"
              className="input min-w-0"
              maxLength={2000}
              onChange={(event) => setTypedQuestion(event.target.value)}
              placeholder="e.g. Tell me about a difficult project"
              value={typedQuestion}
            />
            <button className="btn btn-primary shrink-0" type="submit">
              Ask
            </button>
          </form>
        </section>
      )}
    </div>
  );
}
