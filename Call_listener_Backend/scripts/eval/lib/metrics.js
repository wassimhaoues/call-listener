/**
 * Deterministic metrics for offline live-suggestion evaluation. Nothing here
 * calls a model: every check is plain text matching so results are
 * reproducible and free. They are proxies, not a substitute for the human
 * usefulness review described in docs/plan/05-validation-and-rollout.md.
 */

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Lowercase, unify apostrophes, and collapse every kind of whitespace. */
export function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFC")
    .replaceAll("’", "'")
    .toLowerCase()
    .split(/\s+/u)
    .filter(Boolean)
    .join(" ");
}

function isWordChar(char) {
  return char !== undefined && WORD_CHAR.test(char);
}

/**
 * Case-insensitive whole-term search: "meta" does not match "metadata" and
 * "18 %" matches across any whitespace. Implemented without building a
 * RegExp from fixture text.
 */
export function containsTerm(text, term) {
  const haystack = normalizeText(text);
  const needle = normalizeText(term);
  if (!needle) return false;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    const before = haystack[index - 1];
    const after = haystack[index + needle.length];
    const startsOnWord = isWordChar(needle[0]);
    const endsOnWord = isWordChar(needle.at(-1));
    const leftOk = !startsOnWord || !isWordChar(before);
    const rightOk = !endsOnWord || !isWordChar(after);
    if (leftOk && rightOk) return true;
    index = haystack.indexOf(needle, index + 1);
  }
  return false;
}

/** The subset of `terms` found in `text`, in input order. */
export function findTerms(text, terms) {
  return (terms || []).filter((term) => containsTerm(text, term));
}

/** IDs of evidence items whose key terms appear in `text`. */
export function mentionedEvidenceIds(text, evidence) {
  return (evidence || [])
    .filter((item) => findTerms(text, item.keyTerms).length > 0)
    .map((item) => item.id);
}

/**
 * Numbers with at least two characters ("40", "3.1", "2021"). Single digits
 * are skipped so list markers and "one/two" style counts do not count as
 * metrics.
 */
export function extractNumbers(text) {
  return (String(text ?? "").match(/\d+(?:[.,]\d+)?/g) || [])
    .filter((value) => value.length >= 2);
}

/** Numbers in `answer` that never appear in `sourceText` (invented metrics). */
export function unsupportedNumbers(answer, sourceText) {
  const known = new Set(extractNumbers(sourceText));
  return [...new Set(extractNumbers(answer))].filter((value) => !known.has(value));
}

const EN_STOPWORDS = new Set([
  "the", "and", "to", "of", "in", "is", "i", "my", "with", "for", "that", "on",
  "we", "it", "was", "this", "as", "by", "at", "would", "you", "your", "have",
  "from", "an", "be", "are", "our", "which", "how", "what", "do", "did", "not",
]);
const FR_STOPWORDS = new Set([
  "le", "la", "les", "de", "des", "et", "un", "une", "du", "je", "j", "mon",
  "ma", "mes", "avec", "pour", "que", "qui", "dans", "est", "sur", "nous", "au",
  "aux", "ce", "cette", "pas", "par", "vous", "ai", "été", "d", "l", "n", "ne",
  "mais", "ou", "se", "son", "sa", "ses", "il", "elle", "en",
]);

/**
 * Stopword-ratio language heuristic. Returns "en", "fr", or "unknown" (no
 * stopwords, or a tie) plus the two ratios.
 */
export function detectLanguage(text) {
  const words = normalizeText(text).split(/[^\p{L}]+/u).filter(Boolean);
  let en = 0;
  let fr = 0;
  for (const word of words) {
    if (EN_STOPWORDS.has(word)) en += 1;
    if (FR_STOPWORDS.has(word)) fr += 1;
  }
  const total = words.length || 1;
  let language = "unknown";
  if (en > fr) language = "en";
  if (fr > en) language = "fr";
  return { language, enRatio: en / total, frRatio: fr / total };
}

export function countWords(text) {
  return String(text ?? "").split(/\s+/u).filter((word) => WORD_CHAR.test(word)).length;
}

/** Sentences end in . ! or ? followed by whitespace or the end of the text. */
const SENTENCE_END = new Set([".", "!", "?"]);

export function countSentences(text) {
  // A single linear scan: a run of terminators ends a sentence only when the
  // next character is whitespace or the end, so "3.1%" stays one sentence.
  const value = String(text ?? "");
  const parts = [];
  let start = 0;
  let index = 0;
  while (index < value.length) {
    if (!SENTENCE_END.has(value[index])) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < value.length && SENTENCE_END.has(value[end])) end += 1;
    if (end === value.length || /\s/u.test(value[end])) {
      parts.push(value.slice(start, index));
      start = end;
    }
    index = end;
  }
  parts.push(value.slice(start));
  return parts.filter((part) => countWords(part) > 0).length;
}

/**
 * Length limits per answer-length setting. The prompt asks for at most three
 * short sentences for "short"; the other limits are generous ceilings that
 * stay well under the 600 output-token cap (about 450 English words).
 */
export const LENGTH_LIMITS = Object.freeze({
  short: Object.freeze({ minWords: 5, maxWords: 80, maxSentences: 3 }),
  standard: Object.freeze({ minWords: 5, maxWords: 180 }),
  detailed: Object.freeze({ minWords: 5, maxWords: 380 }),
});

export function checkLength(text, answerLength) {
  const limit = LENGTH_LIMITS[answerLength];
  if (!limit) throw new TypeError(`Unknown answer length: ${answerLength}`);
  const words = countWords(text);
  const sentences = countSentences(text);
  const withinSentences = limit.maxSentences === undefined || sentences <= limit.maxSentences;
  return {
    words,
    sentences,
    passed: words >= limit.minWords && words <= limit.maxWords && withinSentences,
  };
}

/** Phrases that show the answer admits missing evidence instead of inventing it. */
export const MISSING_EVIDENCE_MARKERS = Object.freeze({
  en: Object.freeze([
    "no direct example", "don't have", "do not have", "haven't", "have not",
    "not in my", "no specific", "no evidence", "clarif",
  ]),
  fr: Object.freeze([
    "pas d'exemple", "je n'ai pas", "aucun", "pas eu l'occasion", "pas encore",
    "pas d'expérience", "clarif",
  ]),
});

export function acknowledgesMissingEvidence(text, language) {
  const normalized = normalizeText(text);
  return (MISSING_EVIDENCE_MARKERS[language] || []).some((marker) => normalized.includes(marker));
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

/** Precision/recall of `actualIds` against `expectedIds`; null when undefined. */
export function overlap(actualIds, expectedIds) {
  if (!Array.isArray(actualIds) || !expectedIds?.length) {
    return { precision: null, recall: null };
  }
  const expected = new Set(expectedIds);
  const hits = actualIds.filter((id) => expected.has(id)).length;
  return { precision: ratio(hits, actualIds.length), recall: ratio(hits, expected.size) };
}

/** Nearest-rank percentile; null for an empty list. */
export function percentile(values, p) {
  const sorted = (values || []).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

function mean(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

function rate(records, key) {
  return ratio(records.filter((record) => record[key]).length, records.length);
}

/**
 * Score one generated answer.
 *
 * @param {object} input
 * @param {string} input.answer generated suggestion text
 * @param {object} input.caseDef validated fixture case
 * @param {object} input.question fixture question
 * @param {string[]|null} input.promptEvidenceIds evidence IDs the prompt carried
 * @param {string} input.promptText system prompt plus history sent to the model
 * @param {Array} input.foreignEvidence evidence items of every other case
 */
export function scoreAnswer({ answer, caseDef, question, promptEvidenceIds, promptText, foreignEvidence }) {
  const { language, answerLength, forbiddenClaims } = caseDef.expectations;
  const contextText = JSON.stringify(caseDef.context) + JSON.stringify(caseDef.evidence);
  const forbidden = findTerms(answer, forbiddenClaims);
  const foreign = mentionedEvidenceIds(answer, foreignEvidence);
  const numbers = unsupportedNumbers(answer, contextText);
  const mentioned = mentionedEvidenceIds(answer, caseDef.evidence);
  const promptLeaks = findTerms(promptText, forbiddenClaims)
    .concat(mentionedEvidenceIds(promptText, foreignEvidence));
  const expected = question.expectedEvidenceIds;
  const answerOverlap = overlap(mentioned, expected);
  const promptOverlap = overlap(promptEvidenceIds, expected);
  const detected = detectLanguage(answer);
  const length = checkLength(answer, answerLength);
  const noEvidence = expected.length === 0;
  const missingHandled = noEvidence ? acknowledgesMissingEvidence(answer, language) : null;
  const relevant = noEvidence ? missingHandled : answerOverlap.recall === 1;

  return {
    grounded: forbidden.length === 0 && foreign.length === 0 && numbers.length === 0,
    isolated: promptLeaks.length === 0 && foreign.length === 0,
    relevant,
    languageMatch: detected.language === language,
    lengthCompliant: length.passed,
    forbiddenClaims: forbidden,
    foreignEvidenceIds: foreign,
    unsupportedNumbers: numbers,
    promptLeaks,
    mentionedEvidenceIds: mentioned,
    answerEvidenceRecall: answerOverlap.recall,
    answerEvidencePrecision: answerOverlap.precision,
    promptEvidenceIds,
    promptEvidenceRecall: promptOverlap.recall,
    promptEvidencePrecision: promptOverlap.precision,
    missingEvidenceHandled: missingHandled,
    detectedLanguage: detected.language,
    words: length.words,
    sentences: length.sentences,
  };
}

/** Names of the boolean checks a scored answer failed. */
export function failedChecks(score) {
  return ["grounded", "isolated", "relevant", "languageMatch", "lengthCompliant"]
    .filter((key) => score[key] === false);
}

/**
 * Aggregate per-answer records ({ status, score, latencyMs, inputTokens,
 * outputTokens, costUsd }) for one variant. Only completed answers count
 * toward quality rates; errors and skipped calls are reported separately.
 */
export function aggregateVariant(records) {
  const completed = records.filter((record) => record.status === "ok");
  const scores = completed.map((record) => record.score);
  const latencies = completed.map((record) => record.latencyMs);
  const sum = (key) => completed.reduce((total, record) => total + (record[key] || 0), 0);
  return {
    questions: records.length,
    completed: completed.length,
    errors: records.filter((record) => record.status === "error").length,
    skipped: records.filter((record) => record.status === "skipped").length,
    groundingRate: rate(scores, "grounded"),
    isolationRate: rate(scores, "isolated"),
    relevanceRate: rate(scores, "relevant"),
    languageMatchRate: rate(scores, "languageMatch"),
    lengthComplianceRate: rate(scores, "lengthCompliant"),
    meanAnswerEvidenceRecall: mean(scores.map((score) => score.answerEvidenceRecall)),
    meanPromptEvidenceRecall: mean(scores.map((score) => score.promptEvidenceRecall)),
    meanPromptEvidencePrecision: mean(scores.map((score) => score.promptEvidencePrecision)),
    missingEvidenceHandledRate: rate(
      scores.filter((score) => score.missingEvidenceHandled !== null),
      "missingEvidenceHandled"
    ),
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    costUsd: sum("costUsd"),
  };
}
