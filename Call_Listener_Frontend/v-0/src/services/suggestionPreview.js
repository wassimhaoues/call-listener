// Collapsed view of a long suggestion (for example detailed STAR output from
// the "More detail" action): the first few sentences, keeping line breaks so
// an outline still reads as an outline. Plain text in, plain text out.

export const PREVIEW_MAX_SENTENCES = 3;

// A sentence ends at ., ! or ? (optionally followed by a closing quote or
// bracket) and the whitespace after it.
const SENTENCE_BOUNDARY = /(?<=[.!?]["')\]]?)\s+/u;

function toLines(text) {
  if (typeof text !== "string") return [];
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * The preview text when `text` is longer than `maxSentences` sentences (each
 * non-empty line counts as at least one), or null when it is short enough to
 * show in full.
 */
export function suggestionPreview(text, maxSentences = PREVIEW_MAX_SENTENCES) {
  const lines = toLines(text);
  const kept = [];
  let remaining = maxSentences;
  for (const [index, line] of lines.entries()) {
    const sentences = line.split(SENTENCE_BOUNDARY).filter(Boolean);
    if (sentences.length > remaining) {
      // `remaining` is still positive here: reaching zero returns below.
      kept.push(sentences.slice(0, remaining).join(" "));
      return kept.join("\n");
    }
    kept.push(line);
    remaining -= sentences.length;
    const isLast = index === lines.length - 1;
    if (remaining === 0 && !isLast) return kept.join("\n");
  }
  return null;
}
