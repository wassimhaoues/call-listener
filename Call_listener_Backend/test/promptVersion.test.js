import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildPrompt, PROMPT_VERSION } from "../server/services/ai/promptBuilder.js";
import { loadContexts } from "./helpers/fixtures.js";

// Rendered-template fingerprint per prompt version. When a template change
// makes this test fail, bump PROMPT_VERSION in promptBuilder.js and record the
// new fingerprint here under the new version (keep the old entries).
const FINGERPRINTS = {
  "2026-11-26.2": "d6d0ce7d8650c1aa0a86c7735564002d6caafc4b3d1abf2246a89ed70d416056",
};

const MODES = ["intro", "reply", "regenerate", "shorten", "expand", "clarify"];
const EVIDENCE = [{ requirement: "Redis", evidence: "Led a Redis migration" }];
const ACTION_INPUT = { question: "How did you lead the migration?", previousAnswer: "Outline: staged dual writes." };

function fingerprint() {
  const contexts = loadContexts().valid;
  const hash = createHash("sha256");
  for (const name of Object.keys(contexts).sort()) {
    const context = JSON.stringify(contexts[name].payload);
    for (const mode of MODES) {
      hash.update(`${name}:${mode}\n`);
      hash.update(buildPrompt(context, mode, EVIDENCE, ACTION_INPUT));
      hash.update("\n");
    }
  }
  return hash.digest("hex");
}

test("the fingerprint covers candidate and legacy templates", () => {
  const contexts = loadContexts().valid;
  const firstLines = Object.values(contexts).map((entry) => buildPrompt(JSON.stringify(entry.payload), "reply").split("\n")[0]);
  assert.ok(firstLines.some((line) => line.startsWith("You are a private job-interview assistant")));
  assert.ok(firstLines.some((line) => line.startsWith("Tu es un assistant privé")));
  assert.ok(firstLines.some((line) => line.startsWith("Tu es un assistant francophone")));
});

test("live prompt templates match the fingerprint recorded for PROMPT_VERSION", () => {
  assert.match(PROMPT_VERSION, /^\d{4}-\d{2}-\d{2}\.\d+$/);
  const actual = fingerprint();
  assert.equal(
    FINGERPRINTS[PROMPT_VERSION],
    actual,
    `Prompt templates changed. Bump PROMPT_VERSION and record "${actual}" for it in test/promptVersion.test.js.`
  );
});
