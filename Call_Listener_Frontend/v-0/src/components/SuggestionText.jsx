import React from "react";

/**
 * Render model output as text only. Model replies are untrusted and must never
 * be inserted as HTML in the candidate's desktop client.
 */
export default function SuggestionText({ text }) {
  const lines = typeof text === "string"
    ? text.split("\n").filter((line) => line.trim())
    : [];

  if (lines.length === 0) {
    return <em className="text-[var(--text-2)]">No suggestion yet.</em>;
  }

  return (
    <>
      {lines.map((line, index) => (
        <p key={`${index}-${line}`}>{line}</p>
      ))}
    </>
  );
}
