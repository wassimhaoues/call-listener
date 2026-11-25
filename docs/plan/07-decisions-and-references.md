# Decisions and Technical References

## Decision register

| Decision | Status | Rationale / revisit point |
| --- | --- | --- |
| Candidate-facing product only | Confirmed by user | All workflows support the job applicant; no interviewer product or candidate ranking |
| OpenRouter as the target language-model provider | Requested by user | Candidate can choose the model; keys and constraints stay on backend |
| LangChain + LangGraph in the Node backend | Partially implemented | Locked packages compile and invoke; a bounded one-node LangGraph generation workflow is live, while richer state and orchestration remain behind Phase 4 gates |
| Keep Deepgram initially | Proposed | Isolate language-model migration from speech-provider migration |
| Keep Windows/Electron and current audio integration initially | Proposed | Preserve the functioning capture approach while measuring/fixing lifecycle issues |
| Existing meeting applications carry the interview | Working assumption | No telephony infrastructure exists in the repository; built-in calling would need its own scope |
| Candidate/job text entry before file import | Proposed | Deliver interview value before adding parsers and file storage |
| Small bounded graph with a simple-chain fallback | Proposed | Make orchestration observable and reversible without increasing live-call latency unnecessarily |
| Ephemeral sessions first; optional saved history later | Proposed | Separate reconnect state from durable candidate-owned records |
| No fine-tuning in initial delivery | Proposed | Evaluate model selection, evidence, prompts, and workflow before considering training |

“Planned” and “proposed” are not implemented capabilities. Record changes to these decisions here and adjust phase dependencies instead of silently broadening scope.

## Official references checked during planning

Checked on 2026-09-29. The repository now locks the initial compatible packages, but these references do not imply that live provider calls or graph workflows are implemented.

- [LangChain JavaScript OpenRouter integration](https://reference.langchain.com/javascript/langchain-openrouter) — provider adapter starting point and package compatibility requirements.
- [LangGraph workflow design](https://docs.langchain.com/oss/javascript/langgraph/thinking-in-langgraph) — explicit state, nodes, and routing.
- [LangGraph streaming](https://docs.langchain.com/oss/javascript/langgraph/streaming) — model output and workflow progress; map to the app's own event contract.
- [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence) — distinction between thread checkpoints and cross-thread storage.
- [OpenRouter model catalog](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties) — discovery metadata for the backend model picker.
- [OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection) — endpoint preferences and fallbacks.

## Implementation choices still requiring evidence

Choose exact model IDs using the candidate-interview evaluation set; do not freeze a “best model” based on marketing. Select the supported Node runtime and dependency versions by testing the actual locked graph/provider packages. Benchmark batching and binary audio before changing the transport. Decide persistent storage and authentication expansion before saved multi-device history, not during the live audio migration.
