import test from "node:test";
import assert from "node:assert/strict";
import { selectRelevantEvidence } from "../server/services/interview/evidenceSelector.js";

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

test("returns no evidence for malformed or unrelated context", () => {
  assert.deepEqual(selectRelevantEvidence("not-json", "caller: Redis?"), []);
  assert.deepEqual(selectRelevantEvidence(context, "caller: How is the weather?"), []);
});
