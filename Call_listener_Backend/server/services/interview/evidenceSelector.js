import { isCandidateInterviewContext, parseInterviewContext } from "../../contracts/interviewContext.js";

const STOP_WORDS = new Set(["about", "with", "that", "this", "from", "your", "have", "what", "when", "where", "would", "could", "pour", "avec", "votre", "vous", "dans", "quel", "quelle", "comment", "pourquoi"]);

function tokens(value) {
  return new Set(
    String(value || "").toLowerCase().match(/[\p{L}\p{N}.+#/-]{3,}/gu)?.filter((token) => !STOP_WORDS.has(token)) || []
  );
}

/** Select up to three supplied evidence references relevant to the latest turn. */
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
  return (context.evidence || [])
    .map((item) => {
      const evidenceTokens = tokens(`${item.requirement} ${item.evidence}`);
      return {
        ...item,
        score: [...queryTokens].filter((token) => evidenceTokens.has(token)).length,
      };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map(({ requirement, evidence }) => ({ requirement, evidence }));
}
