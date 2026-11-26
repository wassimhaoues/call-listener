import { isCandidateInterviewContext, parseInterviewContext } from "../../contracts/interviewContext.js";

const STOP_WORDS = new Set(["about", "with", "that", "this", "from", "your", "have", "what", "when", "where", "would", "could", "pour", "avec", "votre", "vous", "dans", "quel", "quelle", "comment", "pourquoi"]);

function tokens(value) {
  return new Set(
    (String(value || "").toLowerCase().match(/[\p{L}\p{N}.+#/-]{3,}/gu) || [])
      // Sentence punctuation is not part of a term: "migration." must match
      // "migration", while "node.js", "c++", and "c#" stay intact.
      .map((token) => token.replace(/[./-]+$/u, ""))
      .filter((token) => token.length >= 3 && !STOP_WORDS.has(token))
  );
}

export const MAX_PROMPT_EVIDENCE = 3;

/** The deterministic fallback: the first approved references, in order. */
export function fallbackEvidence(evidence) {
  return (evidence || [])
    .slice(0, MAX_PROMPT_EVIDENCE)
    .map(({ requirement, evidence: text }) => ({ requirement, evidence: text }));
}

/**
 * Select up to three supplied evidence references relevant to the latest turn.
 * When none matches, fall back to the first three approved references so the
 * prompt never carries the whole (up to 30 item) evidence list.
 */
export function selectRelevantEvidence(contextString, historyString) {
  let rawContext;
  try {
    rawContext = JSON.parse(contextString || "{}");
  } catch {
    return [];
  }
  if (!isCandidateInterviewContext(rawContext)) return [];
  const context = parseInterviewContext(rawContext);
  const latestTurn = String(historyString || "").split("\n").at(-1) || "";
  const queryTokens = tokens(latestTurn);
  const relevant = (context.evidence || [])
    .map((item) => {
      const evidenceTokens = tokens(`${item.requirement} ${item.evidence}`);
      return {
        ...item,
        score: [...queryTokens].filter((token) => evidenceTokens.has(token)).length,
      };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_PROMPT_EVIDENCE)
    .map(({ requirement, evidence }) => ({ requirement, evidence }));
  return relevant.length ? relevant : fallbackEvidence(context.evidence);
}
