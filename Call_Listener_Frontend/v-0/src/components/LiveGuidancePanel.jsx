import React, { useEffect, useId, useState } from "react";
import SuggestionText from "./SuggestionText.jsx";
import { suggestionPreview } from "@/services/suggestionPreview.js";

// What the shown suggestion is: a normal answer or the result of an action.
export const SUGGESTION_KIND_LABELS = Object.freeze({
  answer: "Answer",
  regenerate: "Regenerated answer",
  shorten: "Shorter answer",
  expand: "Detailed answer (STAR)",
  clarify: "Clarifying questions to ask",
});

// Candidate response actions on the current final suggestion. `code` is the
// physical key, so the shortcut works whatever character Alt+key would type.
export const RESPONSE_ACTIONS = Object.freeze([
  { type: "regenerate", label: "Regenerate", shortcut: "Alt+R", code: "KeyR" },
  { type: "shorten", label: "Shorter", shortcut: "Alt+S", code: "KeyS" },
  { type: "expand", label: "More detail", shortcut: "Alt+E", code: "KeyE" },
  { type: "clarify", label: "Clarify", shortcut: "Alt+C", code: "KeyC" },
]);

const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

function isEditableTarget(target) {
  if (!target || typeof target !== "object") return false;
  return target.isContentEditable === true || EDITABLE_TAGS.has(target.tagName);
}

// The response action an Alt+key press asks for, or null. Shortcuts never
// fire while the candidate is typing (for example a typed question).
export function shortcutAction(event) {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (isEditableTarget(event.target)) return null;
  return RESPONSE_ACTIONS.find((action) => action.code === event.code) ?? null;
}

function ResponseActions({ enabled, pendingAction, actionError, onResponseAction }) {
  useEffect(() => {
    function onKeyDown(event) {
      const action = shortcutAction(event);
      if (!action) return;
      event.preventDefault();
      if (enabled && !event.repeat) onResponseAction(action.type);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, onResponseAction]);

  return (
    <div className="mt-3" aria-busy={pendingAction ? true : undefined}>
      <div aria-label="Response actions" className="flex flex-wrap gap-2" role="group">
        {RESPONSE_ACTIONS.map((action) => (
          <button
            aria-keyshortcuts={action.shortcut}
            className="btn btn-ghost h-8 px-2 text-xs"
            disabled={!enabled}
            key={action.type}
            onClick={() => onResponseAction(action.type)}
            title={`${action.label} (${action.shortcut})`}
            type="button"
          >
            {action.label}
          </button>
        ))}
      </div>
      <p className="mt-1 text-xs text-[var(--text-2)]">
        Shortcuts: <kbd>Alt+R</kbd> regenerate, <kbd>Alt+S</kbd> shorter,{" "}
        <kbd>Alt+E</kbd> more detail, <kbd>Alt+C</kbd> clarify (not while typing).
      </p>
      {actionError && (
        <p className="mt-1 text-xs text-[var(--danger)]" role="status">
          {actionError}
        </p>
      )}
    </div>
  );
}

// A completed long suggestion shows its first sentences with a Show more /
// Show less toggle. Streamed (partial) text is always shown in full. The
// expansion belongs to one suggestion: a new suggestion starts collapsed.
function ExpandableSuggestion({ text, isStreaming }) {
  const [expandedText, setExpandedText] = useState(null);
  const contentId = useId();
  const preview = isStreaming ? null : suggestionPreview(text);
  const expanded = expandedText === text;

  if (preview === null) return <SuggestionText text={text} />;
  return (
    <>
      <div id={contentId}>
        <SuggestionText text={expanded ? text : preview} />
      </div>
      <button
        aria-controls={contentId}
        aria-expanded={expanded}
        className="btn btn-ghost h-8 px-2 text-xs"
        onClick={() => setExpandedText(expanded ? null : text)}
        type="button"
      >
        {expanded ? "Show less" : "Show more"}
      </button>
    </>
  );
}

// "Model: <actual || selected>", naming the requested model too when the
// provider reports that a different one served the request.
export function formatModelLabel(model) {
  if (!model?.selected) return "";
  const { selected, actual } = model;
  if (!actual || actual === selected) return `Model: ${selected}`;
  return `Model: ${actual} (requested ${selected})`;
}

export default function LiveGuidancePanel({
  question,
  suggestion,
  evidence = [],
  onSubmitTypedQuestion,
  isThinking = false,
  isStreaming = false,
  truncated = false,
  model = null,
  alerts = [],
  generationKind = null,
  actionsEnabled = false,
  pendingAction = null,
  actionError = "",
  onResponseAction,
}) {
  const [typedQuestion, setTypedQuestion] = useState("");
  const modelLabel = formatModelLabel(model);
  const kindLabel = Object.hasOwn(SUGGESTION_KIND_LABELS, generationKind ?? "")
    ? SUGGESTION_KIND_LABELS[generationKind]
    : "";

  function submitTypedQuestion(event) {
    event.preventDefault();
    const normalizedQuestion = typedQuestion.trim();
    if (!normalizedQuestion) return;
    onSubmitTypedQuestion?.(normalizedQuestion);
    setTypedQuestion("");
  }

  return (
    <div className="space-y-5">
      {alerts.length > 0 && (
        <div
          className="rounded-xl border border-[var(--danger)] px-3 py-2 text-sm text-[var(--danger)]"
          role="alert"
        >
          {alerts.map((alert) => (
            <p key={alert}>{alert}</p>
          ))}
        </div>
      )}
      <section>
        <h2 className="text-sm font-semibold">Current interviewer question</h2>
        <p className="mt-1 text-sm text-[var(--text-2)]">
          {question || "Waiting for an interviewer question…"}
        </p>
      </section>
      <section>
        <h2 className="text-sm font-semibold">Suggested answer</h2>
        {kindLabel && <p className="badge mt-1">{kindLabel}</p>}
        <div className="prose prose-sm max-w-none mt-1" aria-busy={isStreaming || undefined}>
          {isThinking ? (
            <p className="text-[var(--text-2)]" role="status">
              Preparing guidance for this question…
            </p>
          ) : (
            // Streamed text is partial model output: rendered as plain text
            // like the final reply, and replaced by it on completion.
            <ExpandableSuggestion isStreaming={isStreaming} text={suggestion} />
          )}
        </div>
        {isStreaming && (
          <p className="mt-1 text-xs text-[var(--text-2)]" role="status">
            Still writing…
          </p>
        )}
        {truncated && !isStreaming && !isThinking && suggestion && (
          <p className="mt-1 text-xs text-[var(--text-2)]">
            This answer reached the length limit and may end mid-sentence. Use Shorten for a tighter version.
          </p>
        )}
        {!isThinking && !isStreaming && modelLabel && (
          <p className="mt-1 text-xs text-[var(--text-2)]">{modelLabel}</p>
        )}
        {onResponseAction && (
          <ResponseActions
            actionError={actionError}
            enabled={actionsEnabled}
            onResponseAction={onResponseAction}
            pendingAction={pendingAction}
          />
        )}
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
