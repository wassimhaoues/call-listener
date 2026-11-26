import { RunnableLambda, RunnableSequence } from "@langchain/core/runnables";
import { buildPrompt } from "../../../server/services/ai/promptBuilder.js";
import { selectRelevantEvidence } from "../../../server/services/interview/evidenceSelector.js";
import { createInterviewWorkflow } from "../../../server/services/interview/interviewWorkflow.js";

export const VARIANT_NAMES = Object.freeze(["graph", "chain"]);

const EVIDENCE_HEADING = "Candidate evidence references:\n";
const SETTINGS_HEADING = "\n\nInterview settings:";

function formatEvidence(items) {
  return items
    .map((item) => ["- Requirement: ", item.requirement, "\n  Candidate evidence: ", item.evidence].join(""))
    .join("\n");
}

/**
 * The baseline's prompt: promptBuilder's interview-aware reply prompt with
 * its evidence section replaced by every approved reference (no selection
 * and no three-item cap).
 */
export function buildChainPrompt(contextJson) {
  const prompt = buildPrompt(contextJson, "reply", []);
  const start = prompt.indexOf(EVIDENCE_HEADING);
  const end = prompt.indexOf(SETTINGS_HEADING, start);
  if (start === -1 || end === -1) {
    throw new Error("promptBuilder output no longer has the expected evidence section");
  }
  const evidence = JSON.parse(contextJson).evidence || [];
  const section = evidence.length ? formatEvidence(evidence) : "- N/A";
  return prompt.slice(0, start + EVIDENCE_HEADING.length) + section + prompt.slice(end);
}

/**
 * The production path: the LangGraph workflow (selectEvidence ->
 * generateSuggestion) with the real promptBuilder. One compiled workflow is
 * kept per reply generator, as the server compiles one at startup.
 */
export function createGraphVariant() {
  const workflows = new WeakMap();
  const workflowFor = (generateReply) => {
    if (!workflows.has(generateReply)) {
      workflows.set(generateReply, createInterviewWorkflow({ buildPrompt, generateReply }));
    }
    return workflows.get(generateReply);
  };
  return {
    name: "graph",
    planPrompt: (contextJson, history) =>
      buildPrompt(contextJson, "reply", selectRelevantEvidence(contextJson, history)),
    async run({ contextJson, history, generateReply, signal, onUsage, model, onModel }) {
      const state = await workflowFor(generateReply).invoke({
        context: contextJson,
        history,
        signal,
        onUsage,
        model,
        onModel,
      });
      // promptBuilder is pure, so this is exactly the prompt the node sent.
      return {
        suggestion: state.suggestion,
        promptEvidence: state.selectedEvidence,
        prompt: buildPrompt(contextJson, "reply", state.selectedEvidence),
      };
    },
  };
}

/**
 * The simple interview-aware LangChain chain: build one prompt with all
 * approved evidence, then make one model call through the same reply
 * generator contract the graph uses.
 */
export function createChainVariant() {
  const chain = RunnableSequence.from([
    RunnableLambda.from((input) => ({ ...input, prompt: buildChainPrompt(input.contextJson) })),
    RunnableLambda.from(async (input) => {
      const reply = await input.generateReply(input.prompt, input.history, {
        signal: input.signal,
        onUsage: input.onUsage,
        model: input.model,
        onModel: input.onModel,
      });
      return { prompt: input.prompt, suggestion: String(reply || "").trim() };
    }),
  ]);
  return {
    name: "chain",
    planPrompt: (contextJson) => buildChainPrompt(contextJson),
    async run(input) {
      const result = await chain.invoke(input, { signal: input.signal });
      return {
        suggestion: result.suggestion,
        promptEvidence: JSON.parse(input.contextJson).evidence || [],
        prompt: result.prompt,
      };
    },
  };
}

export function createVariant(name) {
  if (name === "graph") return createGraphVariant();
  if (name === "chain") return createChainVariant();
  throw new TypeError(`Unknown variant: ${name}`);
}
