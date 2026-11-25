import { expect, it } from "vitest";
import {
  buildEvidenceReferences,
  createPreparationBrief,
  extractCandidateFacts,
  extractJobRequirements,
} from "../src/services/preparation.js";

it("extracts reviewable candidate facts and job requirements locally", () => {
  expect(extractCandidateFacts(`
    Skills: Node.js, Redis, Docker
    - Led a migration that reduced deployment time by 40%
  `)).toEqual({
    skills: ["Node.js", "Redis", "Docker"],
    achievements: ["Led a migration that reduced deployment time by 40%"],
  });
  expect(extractJobRequirements(`
    Requirements: Node.js and Redis experience.
    You must own reliable platform infrastructure.
  `)).toEqual([
    "Requirements: Node.js and Redis experience.",
    "You must own reliable platform infrastructure.",
  ]);
});

it("creates a preparation brief without adding facts beyond the candidate context", () => {
  expect(createPreparationBrief({
    candidate: { name: "Ada", profile: "a platform engineer", skills: ["Node.js"], achievements: ["Led a Redis migration"] },
    jobOffer: { title: "Platform Engineer", company: "Northstar", requirements: ["Redis experience"] },
  })).toEqual({
    introduction: [
      "Start with: “I’m Ada, a platform engineer.”",
      "For this role, emphasize: Node.js.",
    ],
    starExamples: ["Use this as a STAR example: Led a Redis migration"],
    practiceTopics: ["Redis experience"],
    questions: [
      "What would success look like in the first 90 days for this Platform Engineer?",
      "How does Northstar support this team’s priorities?",
    ],
  });
});

it("creates evidence references only from supplied candidate facts", () => {
  expect(buildEvidenceReferences(
    ["Node.js and Redis experience", "Kubernetes required"],
    {
      skills: ["Node.js", "Redis"],
      achievements: ["Led a Redis migration"],
    }
  )).toEqual([
    { requirement: "Node.js and Redis experience", evidence: "Node.js" },
  ]);
});
