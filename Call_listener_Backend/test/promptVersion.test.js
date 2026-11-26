import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildPrompt, PROMPT_VERSION } from "../server/services/ai/promptBuilder.js";
import { loadContexts } from "./helpers/fixtures.js";

// Rendered-template fingerprint per prompt version. When a template change
// makes this test fail, bump PROMPT_VERSION in promptBuilder.js and record the
// new fingerprint here under the new version (keep the old entries).
const FINGERPRINTS = {
  "2026-11-26.1": "96f4f75c03967e97d986653c3bc31dd4e2d065ea149cb2d05de2c88e4f34cf8f",
};

const MODES = ["intro", "reply", "regenerate", "shorten", "expand", "clarify"];
const EVIDENCE = [{ requirement: "Redis", evidence: "Led a Redis migration" }];
const ACTION_INPUT = { question: "How did you lead the migration?", previousAnswer: "Outline: staged dual writes." };

function fingerprint() {
  const contexts = loadContexts().valid;
  const hash = createHash("sha256");
  for (const name of Object.keys(contexts).sort()) {
    const context = JSON.stringify(contexts[name]);
    for (const mode of MODES) {
      hash.update(`${name}:${mode}\n`);
      hash.update(buildPrompt(context, mode, EVIDENCE, ACTION_INPUT));
      hash.update("\n");
    }
  }
  return hash.digest("hex");
}

test("live prompt templates match the fingerprint recorded for PROMPT_VERSION", () => {
  assert.match(PROMPT_VERSION, /^\d{4}-\d{2}-\d{2}\.\d+$/);
  const actual = fingerprint();
  assert.equal(
    FINGERPRINTS[PROMPT_VERSION],
    actual,
    `Prompt templates changed. Bump PROMPT_VERSION and record "${actual}" for it in test/promptVersion.test.js.`
  );
});
