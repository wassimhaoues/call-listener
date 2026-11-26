import test from "node:test";
import assert from "node:assert/strict";
import { selectRelevantEvidence } from "../server/services/interview/evidenceSelector.js";
import { createInterviewWorkflow } from "../server/services/interview/interviewWorkflow.js";
import { buildPrompt } from "../server/services/ai/promptBuilder.js";

const context = JSON.stringify({
  version: 1,
  candidate: { name: "Ada", profile: "", skills: ["Redis"], achievements: ["Led a Redis migration"] },
  jobOffer: { title: "Platform Engineer", company: "", description: "" },
  settings: { language: "en", stage: "technical", answerLength: "short" },
  evidence: [
    { requirement: "Redis experience", evidence: "Led a Redis migration" },
    { requirement: "Kubernetes experience", evidence: "Operated Kubernetes clusters" },
  ],
});

test("selects only candidate-approved evidence relevant to the latest interviewer question", () => {
  assert.deepEqual(
    selectRelevantEvidence(context, "caller: Tell me about your Redis migration."),
    [{ requirement: "Redis experience", evidence: "Led a Redis migration" }]
  );
});

test("matches a term that ends the interviewer's sentence", () => {
  assert.deepEqual(
    selectRelevantEvidence(context, "caller: Have you worked with Kubernetes."),
    [{ requirement: "Kubernetes experience", evidence: "Operated Kubernetes clusters" }]
  );
  assert.deepEqual(
    selectRelevantEvidence(context, "caller: Tell me about a time you ran a migration."),
    [{ requirement: "Redis experience", evidence: "Led a Redis migration" }]
  );
});

test("returns no evidence for malformed context", () => {
  assert.deepEqual(selectRelevantEvidence("not-json", "caller: Redis?"), []);
});

const manyEvidence = Array.from({ length: 30 }, (_, index) => ({
  requirement: `Requirement ${index + 1}`,
  evidence: `Approved evidence line ${index + 1}`,
}));
const largeContext = JSON.stringify({ ...JSON.parse(context), evidence: manyEvidence });

test("falls back to the first three approved references when nothing matches", () => {
  assert.deepEqual(
    selectRelevantEvidence(context, "caller: How is the weather?"),
    JSON.parse(context).evidence
  );
  assert.deepEqual(
    selectRelevantEvidence(largeContext, "caller: How is the weather?"),
    manyEvidence.slice(0, 3)
  );
});

test("an unmatched question never sends more than three evidence references to the provider", async () => {
  const prompts = [];
  const workflow = createInterviewWorkflow({
    buildPrompt,
    generateReply: async (prompt) => { prompts.push(prompt); return "Ask a clarifying question."; },
  });
  await workflow.invoke({ context: largeContext, history: "caller: How is the weather?" });

  const references = prompts[0].match(/Candidate evidence: /g) || [];
  assert.equal(references.length, 3);
  assert.match(prompts[0], /Approved evidence line 3\n/);
  assert.doesNotMatch(prompts[0], /Approved evidence line 4\n/);
});

test("the intro prompt carries at most three evidence references", () => {
  const prompt = buildPrompt(largeContext, "intro");
  assert.equal((prompt.match(/Candidate evidence: /g) || []).length, 3);
});

test("a follow-up with no topic words inherits evidence from the preceding exchange", () => {
  const history = [
    "caller: Tell me about your Redis migration.",
    "me: We moved sessions off a single node.",
    "assistant: Mention the Kubernetes clusters you operated.",
    "caller: What did you change afterwards?",
  ].join("\n");
  assert.deepEqual(selectRelevantEvidence(context, history), [
    { requirement: "Redis experience", evidence: "Led a Redis migration" },
  ]);
});

test("assistant suggestions never decide the evidence for a follow-up", () => {
  const history = [
    "caller: How is the weather?",
    "assistant: Mention the Kubernetes clusters you operated.",
    "caller: And then?",
  ].join("\n");
  assert.deepEqual(selectRelevantEvidence(context, history), JSON.parse(context).evidence);
});

test("a follow-up only looks back a bounded number of history lines", () => {
  const history = [
    "caller: Tell me about your Redis migration.",
    ...Array.from({ length: 6 }, (_, index) => `me: unrelated remark ${index}`),
    "caller: What did you change afterwards?",
  ].join("\n");
  assert.deepEqual(selectRelevantEvidence(context, history), JSON.parse(context).evidence);
});

test("a latest turn that matches keeps its own evidence and ignores earlier topics", () => {
  const history = [
    "caller: Tell me about your Redis migration.",
    "caller: How do you run Kubernetes clusters?",
  ].join("\n");
  assert.deepEqual(selectRelevantEvidence(context, history), [
    { requirement: "Kubernetes experience", evidence: "Operated Kubernetes clusters" },
  ]);
});
