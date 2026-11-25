import test from "node:test";
import assert from "node:assert/strict";
import { buildPrompt } from "../server/services/ai/promptBuilder.js";

test("buildPrompt creates an introductory French prompt with supplied context", () => {
  const prompt = buildPrompt(
    JSON.stringify({
      caller: { name: "Marie", company: "Acme", other: "SaaS" },
      me: { name: "Alex", company: "Studio", objectives: "Understand needs" },
    }),
    "intro"
  );

  assert.match(prompt, /assistant francophone/i);
  assert.match(prompt, /une seule phrase naturelle/i);
  assert.match(prompt, /Marie/);
  assert.match(prompt, /Acme/);
  assert.match(prompt, /Alex/);
  assert.match(prompt, /Understand needs/);
});

test("buildPrompt uses placeholders for omitted fields", () => {
  const prompt = buildPrompt(JSON.stringify({ caller: {}, me: {} }));

  assert.match(prompt, /Réponds brièvement/i);
  assert.match(prompt, /Nom : N\/A/);
  assert.match(prompt, /Objectifs : N\/A/);
});

test("buildPrompt rejects malformed context instead of silently changing it", () => {
  assert.throws(() => buildPrompt("not-json"), SyntaxError);
});
