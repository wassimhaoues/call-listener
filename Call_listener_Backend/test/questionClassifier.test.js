import test from "node:test";
import assert from "node:assert/strict";
import { isInterviewerQuestion } from "../server/services/interview/questionClassifier.js";

test("recognizes English and French interviewer questions", () => {
  assert.equal(isInterviewerQuestion("Tell me about a migration."), true);
  assert.equal(isInterviewerQuestion("Could you explain your Redis experience?"), true);
  assert.equal(isInterviewerQuestion("Parlez-moi de votre expérience avec Redis."), true);
  assert.equal(isInterviewerQuestion("Pourquoi souhaitez-vous ce poste ?"), true);
});

test("does not treat acknowledgements as paid-generation prompts", () => {
  assert.equal(isInterviewerQuestion("Thanks, that is helpful."), false);
  assert.equal(isInterviewerQuestion("Okay."), false);
  assert.equal(isInterviewerQuestion("Merci."), false);
  assert.equal(isInterviewerQuestion(""), false);
});
