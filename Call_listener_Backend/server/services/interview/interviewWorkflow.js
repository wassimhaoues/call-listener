import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { selectRelevantEvidence } from "./evidenceSelector.js";

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
      selectedEvidence: selectRelevantEvidence(
        state.context,
        state.question ? `caller: ${state.question}` : state.history
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
        onToken: state.onToken,
      });
      return { suggestion: (suggestion || "").trim() };
    })
    .addEdge(START, "selectEvidence")
    .addEdge("selectEvidence", "generateSuggestion")
    .addEdge("generateSuggestion", END)
    .compile();

  return {
    invoke: (input) => graph.invoke(input),
  };
}
