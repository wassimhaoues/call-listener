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

/** How many earlier history lines a follow-up question may inherit its topic from. */
export const FOLLOW_UP_LOOKBACK_LINES = 6;

function rankEvidence(evidence, queryText) {
  const queryTokens = tokens(queryText);
  return (evidence || [])
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
}

/**
 * Select up to three supplied evidence references relevant to the latest turn.
 * A short follow-up ("What did you change afterwards?") rarely repeats its
 * topic, so when the latest turn matches nothing the preceding exchange is
 * used: earlier interviewer questions and the candidate's spoken answers, but
 * never assistant suggestions (they may mention any evidence). When nothing
 * matches at all, fall back to the first three approved references so the
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
  const lines = String(historyString || "").split("\n").filter((line) => line.trim());
  const latest = rankEvidence(context.evidence, lines.at(-1) || "");
  if (latest.length) return latest;
  const precedingExchange = lines
    .slice(-FOLLOW_UP_LOOKBACK_LINES, -1)
    .filter((line) => !line.startsWith("assistant:"))
    .join("\n");
  const inherited = rankEvidence(context.evidence, precedingExchange);
  return inherited.length ? inherited : fallbackEvidence(context.evidence);
}
