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
    selectedEvidence: Annotation({ default: () => [] }),
    suggestion: Annotation({ default: () => "" }),
  });
  const graph = new StateGraph(State)
    .addNode("selectEvidence", (state) => ({
      selectedEvidence: selectRelevantEvidence(state.context, state.history),
    }))
    .addNode("generateSuggestion", async (state) => {
      const prompt = buildPrompt(state.context, "reply", state.selectedEvidence);
      const suggestion = await generateReply(prompt, state.history, {
        signal: state.signal,
        onUsage: state.onUsage,
        model: state.model,
        onModel: state.onModel,
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
