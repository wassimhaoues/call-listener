import test from "node:test";
import assert from "node:assert/strict";
import { replay, summarize, syntheticContext } from "../scripts/bench/promptGrowth.js";
import { parseInterviewContext } from "../server/contracts/interviewContext.js";

test("the prompt-growth benchmark context is a valid candidate context", () => {
  assert.doesNotThrow(() => parseInterviewContext(syntheticContext()));
});

test("prompt growth is bounded by the history limit and repeats a stable prefix", async () => {
  const rows = await replay({ questions: 30, maxEntries: 6 });
  assert.equal(rows.length, 30);
  assert.equal(rows[0].cachedCurrent, 0, "the first request has nothing to reuse");
  assert.ok(rows.slice(1).every((row) => row.cachedCurrent > 0), "later requests share the instructions and candidate data");
  // Once the history is full, requests stop growing.
  const tail = rows.slice(10).map((row) => row.inputTokens);
  assert.ok(Math.max(...tail) - Math.min(...tail) < 50);
  const summary = summarize(rows);
  assert.equal(summary.questions, 30);
  assert.ok(summary.reusableCurrent <= summary.totalInputTokens);
});
