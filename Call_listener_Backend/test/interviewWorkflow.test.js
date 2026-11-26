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

test("the workflow rejects malformed input before any model call", async () => {
  const { createInterviewWorkflow, WorkflowValidationError, MAX_WORKFLOW_HISTORY_CHARS } = await import(
    "../server/services/interview/interviewWorkflow.js"
  );
  let calls = 0;
  const workflow = createInterviewWorkflow({
    buildPrompt: () => "prompt",
    generateReply: async () => {
      calls += 1;
      return "Answer";
    },
  });
  const valid = { context: "", history: "caller: Hi?" };
  for (const input of [
    { ...valid, history: 42 },
    { ...valid, history: "x".repeat(MAX_WORKFLOW_HISTORY_CHARS + 1) },
    { ...valid, mode: "delete_everything" },
    { ...valid, onToken: "not a function" },
    { ...valid, signal: {} },
    { ...valid, model: "" },
  ]) {
    await assert.rejects(workflow.invoke(input), (error) => {
      assert.ok(error instanceof WorkflowValidationError);
      assert.equal(error.code, "invalid_workflow_state");
      assert.doesNotMatch(error.message, /caller: Hi/, "messages never echo history text");
      return true;
    });
  }
  assert.equal(calls, 0);
  const result = await workflow.invoke({ ...valid, mode: "shorten", question: "Q?", previousAnswer: "A." });
  assert.equal(result.suggestion, "Answer");
});

test("the workflow rejects an oversized suggestion from the generator", async () => {
  const { createInterviewWorkflow, MAX_WORKFLOW_SUGGESTION_CHARS } = await import(
    "../server/services/interview/interviewWorkflow.js"
  );
  const workflow = createInterviewWorkflow({
    buildPrompt: () => "prompt",
    generateReply: async () => "y".repeat(MAX_WORKFLOW_SUGGESTION_CHARS + 1),
  });
  await assert.rejects(workflow.invoke({ context: "", history: "caller: Hi?" }), /generateSuggestion output/);
});
