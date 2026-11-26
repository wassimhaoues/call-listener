import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { z } from "zod";
import { MAX_PROMPT_EVIDENCE, selectRelevantEvidence } from "./evidenceSelector.js";
import { isActionMode } from "../ai/promptBuilder.js";

// Generous upper bounds: the context contract and the 40-turn history keep
// real inputs far below these; anything larger is a caller bug, not data.
export const MAX_WORKFLOW_CONTEXT_CHARS = 256_000;
export const MAX_WORKFLOW_HISTORY_CHARS = 512_000;
// A suggestion is bounded by the output-token cap; this is a sanity bound.
export const MAX_WORKFLOW_SUGGESTION_CHARS = 32_000;

/** A workflow input or node output broke the contract below. */
export class WorkflowValidationError extends Error {
  constructor(where, issues) {
    super(`Invalid interview workflow ${where}: ${issues}`);
    this.name = "WorkflowValidationError";
    this.code = "invalid_workflow_state";
  }
}

const optionalCallback = z.custom((value) => typeof value === "function", "expected a function").optional();

const WorkflowInputSchema = z.object({
  context: z.string().max(MAX_WORKFLOW_CONTEXT_CHARS),
  history: z.string().max(MAX_WORKFLOW_HISTORY_CHARS),
  mode: z.string().refine((mode) => mode === "reply" || isActionMode(mode), "unknown mode").optional(),
  // Quoted into action prompts as data and truncated there.
  question: z.string().optional(),
  previousAnswer: z.string().optional(),
  model: z.string().min(1).max(128).nullish(),
  signal: z.custom((value) => value instanceof AbortSignal, "expected an AbortSignal").optional(),
  onUsage: optionalCallback,
  onModel: optionalCallback,
  onFinish: optionalCallback,
  onToken: optionalCallback,
});

const SelectedEvidenceSchema = z.array(z.object({
  requirement: z.string(),
  evidence: z.string(),
})).max(MAX_PROMPT_EVIDENCE);

const SuggestionSchema = z.string().max(MAX_WORKFLOW_SUGGESTION_CHARS);

function validated(schema, value, where) {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  // Paths and messages only: never echo context, history, or reply text.
  const issues = result.error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`)
    .join("; ");
  throw new WorkflowValidationError(where, issues);
}

/**
 * Build the smallest useful, bounded LangGraph workflow for a completed
 * interviewer turn. More classification and evidence-selection nodes can be
 * added only when their measured value justifies live-call latency.
 */
export function createInterviewWorkflow({ buildPrompt, generateReply } = {}) {
  if (typeof buildPrompt !== "function" || typeof generateReply !== "function") {
    throw new TypeError("buildPrompt and generateReply are required");
  }

  const State = Annotation.Root({
    context: Annotation({ default: () => "" }),
    history: Annotation({ default: () => "" }),
    signal: Annotation({ default: () => undefined }),
    onUsage: Annotation({ default: () => undefined }),
    model: Annotation({ default: () => undefined }),
    onModel: Annotation({ default: () => undefined }),
    // Optional: told whether the reply stopped at the output-token cap.
    onFinish: Annotation({ default: () => undefined }),
    // Optional: when set, the reply generator streams text deltas to it.
    onToken: Annotation({ default: () => undefined }),
    // "reply" for an interview answer, or a response-action kind
    // ("regenerate", "shorten", "expand", "clarify").
    mode: Annotation(),
    // Response actions only: the interviewer question and, for shorten and
    // expand, the previous final answer. Both reach the prompt as data.
    question: Annotation(),
    previousAnswer: Annotation(),
    selectedEvidence: Annotation({ default: () => [] }),
    suggestion: Annotation({ default: () => "" }),
  });
  const graph = new StateGraph(State)
    .addNode("selectEvidence", (state) => ({
      // An action reuses its question's evidence: by then the history ends
      // with the answer, not the question.
      selectedEvidence: validated(
        SelectedEvidenceSchema,
        selectRelevantEvidence(state.context, state.question ? `caller: ${state.question}` : state.history),
        "selectEvidence output"
      ),
    }))
    .addNode("generateSuggestion", async (state) => {
      const prompt = buildPrompt(state.context, state.mode || "reply", state.selectedEvidence, {
        question: state.question,
        previousAnswer: state.previousAnswer,
      });
      const suggestion = await generateReply(prompt, state.history, {
        signal: state.signal,
        onUsage: state.onUsage,
        model: state.model,
        onModel: state.onModel,
        onFinish: state.onFinish,
        onToken: state.onToken,
      });
      return { suggestion: validated(SuggestionSchema, (suggestion || "").trim(), "generateSuggestion output") };
    })
    .addEdge(START, "selectEvidence")
    .addEdge("selectEvidence", "generateSuggestion")
    .addEdge("generateSuggestion", END)
    .compile();

  return {
    // Validated before any node runs, so a malformed call never reaches the
    // provider.
    invoke: async (input) => {
      validated(WorkflowInputSchema, input, "input");
      return graph.invoke(input);
    },
  };
}
