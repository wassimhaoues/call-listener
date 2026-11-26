import React from "react";
import { suggestionBlocks } from "@/services/suggestionSections.js";

/**
 * Render model output as text only. Model replies are untrusted and must never
 * be inserted as HTML in the candidate's desktop client. Known section
 * headings (Answer outline, STAR detail, Evidence used, and the French
 * equivalents) and bullet lines get structure; everything stays React text.
 */
export default function SuggestionText({ text }) {
  const blocks = suggestionBlocks(text);

  if (blocks.length === 0) {
    return <em className="text-[var(--text-2)]">No suggestion yet.</em>;
  }

  // Group consecutive bullet items into one list.
  const groups = [];
  for (const block of blocks) {
    const last = groups.at(-1);
    if (block.type === "item" && last?.type === "list") last.items.push(block.text);
    else if (block.type === "item") groups.push({ type: "list", items: [block.text] });
    else groups.push(block);
  }

  return (
    <>
      {groups.map((group, index) => {
        const key = `${index}-${group.type}`;
        if (group.type === "heading") {
          return (
            <h4 className="mt-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-2)]" key={key}>
              {group.label}
            </h4>
          );
        }
        if (group.type === "list") {
          return (
            <ul className="list-disc pl-5" key={key}>
              {group.items.map((item, itemIndex) => (
                <li key={`${itemIndex}-${item}`}>{item}</li>
              ))}
            </ul>
          );
        }
        return <p key={key}>{group.text}</p>;
      })}
    </>
  );
}
