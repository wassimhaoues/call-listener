import { createOpenRouterReplyGenerator } from "../../../server/services/ai/openRouterService.js";
import { estimateTokens } from "../../../server/services/ai/interviewBudget.js";

export const FAKE_MODEL_ID = "fake/deterministic-v1";

const REQUIREMENT_PREFIX = "- Requirement: ";
const EVIDENCE_PREFIX = "  Candidate evidence: ";
const FAKE_STOPWORDS = new Set([
  "about", "with", "that", "this", "from", "your", "have", "what", "when", "where", "would",
  "could", "tell", "time", "describe", "give", "example", "they", "them", "there", "were",
  "pour", "avec", "votre", "vous", "dans", "quel", "quelle", "quels", "comment", "pourquoi",
  "avez", "êtes", "parlez", "racontez", "décrivez", "une", "des", "les", "est", "été",
]);

function promptSetting(prompt, label) {
  const prefix = `- ${label}: `;
  const line = prompt.split("\n").find((entry) => entry.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : "";
}

/** Evidence references in prompt order, parsed from promptBuilder's format. */
export function parsePromptEvidence(prompt) {
  const lines = String(prompt ?? "").split("\n");
  const items = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    const next = lines[index + 1];
    if (lines[index].startsWith(REQUIREMENT_PREFIX) && next.startsWith(EVIDENCE_PREFIX)) {
      items.push({
        requirement: lines[index].slice(REQUIREMENT_PREFIX.length),
        evidence: next.slice(EVIDENCE_PREFIX.length),
      });
    }
  }
  return items;
}

function words(value) {
  return new Set(
    String(value ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 4 && !FAKE_STOPWORDS.has(word))
  );
}

function rankEvidence(items, query) {
  const queryWords = words(query);
  return items
    .map((item, index) => {
      const itemWords = words(`${item.requirement} ${item.evidence}`);
      return { item, index, score: [...queryWords].filter((word) => itemWords.has(word)).length };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.item);
}

/**
 * Pick the prompt evidence a careful model would use: matches for the latest
 * interviewer turn, else for earlier interviewer turns (newest first).
 */
function pickEvidence(items, history, limit) {
  const interviewerTurns = String(history ?? "").split("\n")
    .filter((line) => line.startsWith("caller: "))
    .map((line) => line.slice("caller: ".length))
    .reverse();
  for (const turn of interviewerTurns) {
    const ranked = rankEvidence(items, turn);
    if (ranked.length) return ranked.slice(0, limit);
  }
  return [];
}

const TEMPLATES = {
  en: {
    missing: "I do not have a direct example of that in my prepared evidence. I would say so honestly and ask a clarifying question about what the team needs.",
    shortLead: "I would answer with this example: ",
    shortJoin: "; and ",
    shortClose: "That directly covers ",
    outline: "Answer outline: lead with ",
    outlineClose: " and connect it to the role.",
    star: "STAR detail: Situation and task: ",
    starAction: ". Action and result: ",
    used: "Evidence used:",
  },
  fr: {
    missing: "Je n'ai pas d'exemple direct de cela dans mes éléments préparés. Je le dirais honnêtement et je poserais une question de clarification sur les besoins de l'équipe.",
    shortLead: "Je m'appuierais sur cet exemple : ",
    shortJoin: " ; et ",
    shortClose: "Cela répond directement au besoin ",
    outline: "Plan de réponse : commencer par ",
    outlineClose: " et le relier au poste.",
    star: "Détail STAR : Situation et tâche : ",
    starAction: ". Action et résultat : ",
    used: "Éléments utilisés :",
  },
};

/** The deterministic fake answer for a prompt built by promptBuilder.js. */
export function fakeAnswer(systemPrompt, history) {
  const language = promptSetting(systemPrompt, "Language") === "en" ? "en" : "fr";
  const answerLength = promptSetting(systemPrompt, "Preferred answer length") || "standard";
  const text = TEMPLATES[language];
  const limit = answerLength === "detailed" ? 3 : 2;
  const chosen = pickEvidence(parsePromptEvidence(systemPrompt), history, limit);
  if (!chosen.length) return text.missing;
  const requirements = chosen.map((item) => item.requirement).join(", ");
  if (answerLength === "short") {
    const examples = chosen.map((item) => item.evidence).join(text.shortJoin);
    return [text.shortLead, examples, ". ", text.shortClose, requirements, "."].join("");
  }
  const lines = [[text.outline, requirements, text.outlineClose].join("")];
  if (answerLength === "detailed") {
    lines.push([text.star, chosen[0].requirement, text.starAction, chosen[0].evidence, "."].join(""));
  }
  lines.push(text.used, ...chosen.map((item) => ["- ", item.requirement, ": ", item.evidence].join("")));
  return lines.join("\n");
}

function abortError(signal) {
  return signal.reason ?? new Error("aborted");
}

/**
 * Deterministic, free stand-in for the OpenRouter adapter with the same
 * `generateReply(systemPrompt, history, options)` contract. Usage is reported
 * as ceil(chars / 4) so cost columns show what the prompts would cost.
 */
export function createFakeReplyGenerator() {
  return async function generateReply(systemPrompt, history, { signal, onUsage, onModel } = {}) {
    if (signal?.aborted) throw abortError(signal);
    await Promise.resolve();
    if (signal?.aborted) throw abortError(signal);
    const text = fakeAnswer(String(systemPrompt ?? ""), String(history ?? ""));
    const inputChars = String(systemPrompt ?? "").length + String(history ?? "").length;
    await onUsage?.(
      { input_tokens: estimateTokens(inputChars), output_tokens: estimateTokens(text.length) },
      { inputChars, outputChars: text.length }
    );
    onModel?.({ selected: FAKE_MODEL_ID, actual: FAKE_MODEL_ID });
    return text;
  };
}

/**
 * A generator that never answers until it is aborted. The cancellation check
 * uses it so cancellation is measured without any provider call.
 */
export function createHangingReplyGenerator(onStart) {
  return (systemPrompt, history, { signal } = {}) => new Promise((resolve, reject) => {
    onStart?.();
    if (!signal) return;
    if (signal.aborted) reject(abortError(signal));
    else signal.addEventListener("abort", () => reject(abortError(signal)), { once: true });
  });
}

/** The production OpenRouter adapter configured from a resolved live config. */
export function createLiveReplyGenerator(config, { ChatOpenRouterClass } = {}) {
  return createOpenRouterReplyGenerator({
    apiKey: config.apiKey,
    model: config.model,
    allowedModels: config.allowedModels,
    maxOutputTokens: config.maxOutputTokens,
    requestTimeoutMs: config.requestTimeoutMs,
    // Evaluation runs are sequential and cost-guarded per call; a retry
    // would blur latency measurements, so they never retry.
    maxRetries: 0,
    ...(ChatOpenRouterClass ? { ChatOpenRouterClass } : {}),
  });
}
