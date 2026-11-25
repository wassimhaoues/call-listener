import test from "node:test";
import assert from "node:assert/strict";
import { parseInterviewContext } from "../server/contracts/interviewContext.js";
import { buildPrompt } from "../server/services/ai/promptBuilder.js";

const candidateContext = {
  version: 1,
  candidate: {
    name: "Ada",
    profile: "Platform engineer with distributed-systems experience.",
    skills: ["Node.js", "Redis"],
    achievements: ["Reduced deployment time by 40%"],
  },
  jobOffer: {
    title: "Senior Platform Engineer",
    company: "Northstar",
    description: "Own reliable developer infrastructure.",
    requirements: ["Node.js and Redis experience"],
  },
  evidence: [{ requirement: "Node.js and Redis experience", evidence: "Reduced deployment time by 40%" }],
  settings: { language: "en", stage: "technical", answerLength: "short" },
};

test("validates a bounded candidate and job-offer context", () => {
  assert.deepEqual(parseInterviewContext(candidateContext), candidateContext);
  assert.throws(
    () => parseInterviewContext({ ...candidateContext, candidate: { ...candidateContext.candidate, skills: Array(41).fill("Node.js") } }),
    /Too big/
  );
});

test("builds an interview prompt grounded in candidate evidence and job details", () => {
  const prompt = buildPrompt(JSON.stringify(candidateContext), "reply");

  assert.match(prompt, /private job-interview assistant/i);
  assert.match(prompt, /Never invent experience/i);
  assert.match(prompt, /Ada/);
  assert.match(prompt, /Reduced deployment time by 40%/);
  assert.match(prompt, /Senior Platform Engineer/);
  assert.match(prompt, /technical/);
  assert.match(prompt, /Node\.js and Redis experience/);
  assert.match(prompt, /Candidate evidence/);
  assert.match(prompt, /no more than three short sentences/i);
});
