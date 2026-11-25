import test from "node:test";
import assert from "node:assert/strict";
import { createInterviewWorkflow } from "../server/services/interview/interviewWorkflow.js";

test("LangGraph workflow creates one grounded suggestion for a completed turn", async () => {
  const calls = [];
  const workflow = createInterviewWorkflow({
    buildPrompt: (context, mode) => {
      calls.push({ type: "prompt", context, mode });
      return "grounded prompt";
    },
    generateReply: async (prompt, history, options) => {
      calls.push({ type: "reply", prompt, history, options });
      return "  Use your migration example.  ";
    },
  });

  const result = await workflow.invoke({
    context: "candidate context",
    history: "interviewer: Describe a migration.",
  });

  assert.equal(result.suggestion, "Use your migration example.");
  assert.deepEqual(calls.slice(0, 1), [
    { type: "prompt", context: "candidate context", mode: "reply" },
  ]);
  assert.equal(calls[1].type, "reply");
  assert.equal(calls[1].prompt, "grounded prompt");
  assert.equal(calls[1].history, "interviewer: Describe a migration.");
  assert.equal(calls[1].options.signal, undefined);
});

test("LangGraph workflow requires its prompt and provider functions", () => {
  assert.throws(() => createInterviewWorkflow(), /buildPrompt and generateReply are required/);
});
