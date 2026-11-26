import test from "node:test";
import assert from "node:assert/strict";
import {
  acknowledgesMissingEvidence,
  aggregateVariant,
  checkLength,
  containsTerm,
  countSentences,
  detectLanguage,
  failedChecks,
  mentionedEvidenceIds,
  overlap,
  percentile,
  scoreAnswer,
  unsupportedNumbers,
} from "../scripts/eval/lib/metrics.js";

const caseDef = {
  context: {
    version: 1,
    candidate: { name: "Ada Test", profile: "Engineer since 2019 at Example Works." },
    jobOffer: { title: "Engineer" },
    settings: { language: "en", answerLength: "short" },
  },
  evidence: [
    { id: "A-E1", requirement: "Caching", evidence: "Added a Redis cache that cut load by 40%", keyTerms: ["Redis cache"] },
    { id: "A-E2", requirement: "Testing", evidence: "Wrote contract tests for 12 services", keyTerms: ["contract tests"] },
  ],
  expectations: { language: "en", answerLength: "short", forbiddenClaims: ["Globex", "Meta"] },
};
const foreignEvidence = [
  { id: "B-E1", requirement: "Mobile", evidence: "Shipped a kiosk app", keyTerms: ["kiosk app"] },
];
const question = { id: "q1", type: "technical", expectedEvidenceIds: ["A-E1"] };

function score(answer, overrides = {}) {
  return scoreAnswer({
    answer,
    caseDef,
    question: overrides.question || question,
    promptEvidenceIds: overrides.promptEvidenceIds ?? ["A-E1", "A-E2"],
    promptText: overrides.promptText ?? "prompt about Redis cache and contract tests",
    foreignEvidence,
  });
}

test("term matching is case-insensitive, whole-term, and whitespace tolerant", () => {
  assert.equal(containsTerm("We used META tooling", "Meta"), true);
  assert.equal(containsTerm("We stored metadata", "Meta"), false);
  assert.equal(containsTerm("a 18 % drop", "18 %"), true);
  assert.equal(containsTerm("avoid 118 % claims", "18 %"), false);
  assert.equal(containsTerm("l’équipe", "l'équipe"), true);
  assert.equal(containsTerm("anything", ""), false);
  assert.deepEqual(mentionedEvidenceIds("Our redis CACHE helped", caseDef.evidence), ["A-E1"]);
});

test("numbers absent from the candidate context are reported as unsupported", () => {
  const source = "cut load by 40% for 12 services in 2019";
  assert.deepEqual(unsupportedNumbers("It cut load by 40% across 12 services.", source), []);
  assert.deepEqual(unsupportedNumbers("It cut load by 65% in 2023, step 1.", source), ["65", "2023"]);
});

test("language detection uses English and French stopword counts", () => {
  assert.equal(detectLanguage("I would answer with the example of my cache work.").language, "en");
  assert.equal(detectLanguage("Je m'appuierais sur cet exemple et sur les tests de la plateforme.").language, "fr");
  assert.equal(detectLanguage("Kubernetes Terraform Grafana").language, "unknown");
});

test("length compliance follows the answer-length setting", () => {
  assert.equal(countSentences("One. Two! Three? Four."), 4);
  assert.equal(countSentences("Raised conversion from 3.1% to 4.0% overall."), 1);
  assert.equal(checkLength("This is a short answer. It has two sentences.", "short").passed, true);
  assert.equal(checkLength("One answer here. Two answer here. Three answer here. Four answer here.", "short").passed, false);
  assert.equal(checkLength("Too short", "standard").passed, false);
  assert.equal(checkLength(Array.from({ length: 400 }, () => "word").join(" "), "detailed").passed, false);
  assert.throws(() => checkLength("text", "huge"), /Unknown answer length/);
});

test("missing-evidence acknowledgement is language specific", () => {
  assert.equal(acknowledgesMissingEvidence("I don’t have a direct example of that.", "en"), true);
  assert.equal(acknowledgesMissingEvidence("Je n'ai pas d'exemple direct.", "fr"), true);
  assert.equal(acknowledgesMissingEvidence("I led a large Rust rewrite.", "en"), false);
});

test("overlap and percentile helpers handle empty and partial inputs", () => {
  assert.deepEqual(overlap(["A", "B"], ["A"]), { precision: 0.5, recall: 1 });
  assert.deepEqual(overlap(["A"], []), { precision: null, recall: null });
  assert.deepEqual(overlap(null, ["A"]), { precision: null, recall: null });
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([5, 1, 3, 2, 4], 95), 5);
});

test("a grounded, relevant answer passes every check", () => {
  const result = score("I would mention the Redis cache that cut load by 40%. It fits the role.");
  assert.deepEqual(failedChecks(result), []);
  assert.deepEqual(result.mentionedEvidenceIds, ["A-E1"]);
  assert.equal(result.promptEvidenceRecall, 1);
  assert.equal(result.promptEvidencePrecision, 0.5);
});

test("forbidden claims, invented metrics, and foreign evidence fail grounding", () => {
  assert.deepEqual(score("At Globex my Redis cache cut load by 40%.").forbiddenClaims, ["Globex"]);
  const invented = score("My Redis cache cut load by 75%.");
  assert.equal(invented.grounded, false);
  assert.deepEqual(invented.unsupportedNumbers, ["75"]);
  const foreign = score("I shipped a kiosk app and a Redis cache.");
  assert.equal(foreign.grounded, false);
  assert.equal(foreign.isolated, false);
  assert.deepEqual(foreign.foreignEvidenceIds, ["B-E1"]);
});

test("context isolation fails when the prompt carries another case's facts", () => {
  const result = score("My Redis cache helped the team.", { promptText: "Candidate worked at Globex on a kiosk app" });
  assert.equal(result.isolated, false);
  assert.deepEqual(result.promptLeaks, ["Globex", "B-E1"]);
});

test("relevance needs every expected evidence item, or honest missing-evidence handling", () => {
  const multipart = { id: "q2", type: "multipart", expectedEvidenceIds: ["A-E1", "A-E2"] };
  assert.equal(score("My Redis cache helped the team a lot.", { question: multipart }).relevant, false);
  assert.equal(score("My Redis cache and contract tests helped.", { question: multipart }).relevant, true);
  const noEvidence = { id: "q3", type: "no-evidence", expectedEvidenceIds: [] };
  const honest = score("I do not have a direct example of that. I would ask a clarifying question.", { question: noEvidence });
  assert.equal(honest.relevant, true);
  assert.equal(honest.missingEvidenceHandled, true);
  assert.equal(score("Yes, I did that for years at the company.", { question: noEvidence }).relevant, false);
});

test("aggregation counts only completed answers toward quality rates", () => {
  const good = { status: "ok", score: score("My Redis cache cut load by 40%. Good fit."), latencyMs: 10, inputTokens: 100, outputTokens: 20, costUsd: 0.001 };
  const bad = { status: "ok", score: score("At Globex I did it."), latencyMs: 30, inputTokens: 50, outputTokens: 10, costUsd: 0.0005 };
  const aggregate = aggregateVariant([good, bad, { status: "error" }, { status: "skipped" }]);
  assert.equal(aggregate.questions, 4);
  assert.equal(aggregate.completed, 2);
  assert.equal(aggregate.errors, 1);
  assert.equal(aggregate.skipped, 1);
  assert.equal(aggregate.groundingRate, 0.5);
  assert.equal(aggregate.latencyP50Ms, 10);
  assert.equal(aggregate.latencyP95Ms, 30);
  assert.equal(aggregate.inputTokens, 150);
  assert.ok(Math.abs(aggregate.costUsd - 0.0015) < 1e-12);
});
