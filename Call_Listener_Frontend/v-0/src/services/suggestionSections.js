// Turns a plain-text suggestion into display blocks: the known section
// headings the prompts ask for, bullet items, and paragraphs. Model output is
// untrusted; this only classifies lines and strips Markdown bold markers,
// and the result is rendered as React text (never HTML).

// Section headings requested by promptBuilder.js (answer formats), English
// and French. The displayed label is the canonical one from this table, so
// model text never becomes a heading.
const SECTION_HEADINGS = [
  ["answer outline", "Answer outline"],
  ["star detail", "STAR detail"],
  ["evidence used", "Evidence used"],
  ["plan de réponse", "Plan de réponse"],
  ["détail star", "Détail STAR"],
  ["éléments utilisés", "Éléments utilisés"],
];

// "## Answer outline", "**Answer outline:**", "Answer outline - text", …
const HEADING_LINE = /^#{0,6}\s*[*_]{0,2}\s*([^:*_#–—-]+?)\s*[*_]{0,2}\s*(?:[:–—-]\s*[*_]{0,2}\s*(.*))?$/u;
const BULLET_LINE = /^(?:[-*•]|\d{1,2}[.)])\s+(.*)$/u;

function stripEmphasis(text) {
  // Only bold markers: `__` and single `*`/`_` also occur in real text.
  return text.replaceAll("**", "").trim();
}

function headingFor(line) {
  const match = HEADING_LINE.exec(line);
  if (!match) return null;
  const key = match[1].trim().toLocaleLowerCase("fr");
  const entry = SECTION_HEADINGS.find(([name]) => name === key);
  if (!entry) return null;
  return { label: entry[1], rest: stripEmphasis(match[2] ?? "") };
}

/**
 * @returns {Array<{ type: "heading", label: string } | { type: "item" | "text", text: string }>}
 */
export function suggestionBlocks(text) {
  if (typeof text !== "string") return [];
  const blocks = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const heading = headingFor(line);
    if (heading) {
      blocks.push({ type: "heading", label: heading.label });
      if (heading.rest) blocks.push({ type: "text", text: heading.rest });
      continue;
    }
    const bullet = BULLET_LINE.exec(line);
    const content = stripEmphasis(bullet ? bullet[1] : line);
    if (content) blocks.push({ type: bullet ? "item" : "text", text: content });
  }
  return blocks;
}
