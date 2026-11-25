# Target Architecture and Contracts

Everything in this file is proposed. No new endpoints, environment variables, or packages are implemented yet.

## Component boundaries

```text
Candidate workspace (React)
  ├─ narrow preload IPC → Electron credentials, ticket requests, Windows routing
  └─ versioned WebSocket → session coordinator → speech adapter (Deepgram)
                                             → interview workflow (LangGraph)
                                                  ├─ evidence/context selection
                                                  ├─ LangChain → OpenRouter
                                                  └─ validated suggestion events
                               Redis: active state, resume buffer, TTLs
                               Persistent store: optional saved candidate data
```

Stay in the existing Node backend; a Python service is unnecessary for this migration. Extract responsibilities into `server/services/ai/providers/`, `server/services/interview/`, `server/services/sessions/`, and `server/contracts/`. On the frontend, extract `src/features/interview/`, `src/hooks/`, and `src/services/` from the large conversation component. These are proposed directories, not instructions to move everything at once.

## OpenRouter and LangChain

Define a provider interface for complete and streamed responses, cancellation, normalized errors, usage, and actual model metadata. Route both the introductory/context path and live-reply path through it. The LangChain `ChatOpenRouter` integration is the preferred starting point, subject to a compatibility spike and pinned package versions. [Official integration reference](https://reference.langchain.com/javascript/langchain-openrouter).

The backend alone holds `OPENROUTER_API_KEY`. Proposed settings include `AI_PROVIDER`, `OPENROUTER_DEFAULT_MODEL`, `OPENROUTER_ALLOWED_MODELS`, and request/token/cost limits. Validate only credentials required by the selected provider; OpenRouter mode must start without a Groq key. Keep Groq only as a temporary explicit rollback adapter, not an undisclosed runtime fallback.

The model picker consumes a backend-cached, allowlisted catalog. Show model ID, price units, context capacity, and verified capabilities. Model-level catalog metadata is a discovery input, not proof that every routed endpoint supports every parameter; test the selected route. Refresh availability and handle removed models without silently changing the candidate's choice. [OpenRouter models API](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties).

Pin the selected model per generation. A switch takes effect on the next generation. Record requested and actual model/provider, usage, and fallback reason. Cross-model fallback is opt-in and restricted to approved IDs; endpoint fallback must honor configured capability, privacy, and cost constraints. Never join partial output from two models into one answer. [Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection).

## LangGraph workflow

Use a small graph, not a collection of autonomous agents on every audio packet:

```text
final interviewer turn / candidate action
 → normalize and deduplicate
 → decide if assistance is needed
 → select job requirements + candidate evidence + recent conversation
 → generate concise answer support
 → validate output and evidence references
 → publish completed suggestion + update bounded memory
```

Skip acknowledgements without calling a model where practical. Start with one model call per accepted question. Additional classification, repair, retrieval, or summarization calls need measured quality benefit and a latency budget. Keep heavy preparation/debrief work outside the live path.

Graph state includes owner/session ID, context version, language, recent turns, summary, current question ID, selected model, generation ID, evidence references, usage, and cancellation status. Serialize state mutations per session. A newer question marks old output stale; cancel obsolete generation and process the newest relevant question with bounded pending work. Preserve every accepted final transcript even when a suggestion is superseded.

Stream only candidate-facing answer content and status. With structured output, publish complete validated fields; never render raw partial JSON or model reasoning. On failure, mark partial output incomplete and offer retry. Map framework streaming to our stable wire protocol instead of exposing framework events directly. [LangGraph streaming](https://docs.langchain.com/oss/javascript/langgraph/streaming).

For the first graph release, application session state in Redis can feed a bounded graph per turn; do not advertise durable graph execution. If checkpointing is introduced, use owner-scoped thread IDs, select and test a compatible persistent checkpointer, and coordinate retention/deletion across both stores. In-memory checkpoints do not survive restarts. [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence).

## Proposed domain contracts

| Object | Essential fields |
| --- | --- |
| CandidateProfile | `id`, `version`, `name`, `skills`, `experiences`, evidence records with stable IDs |
| JobOffer | `id`, `version`, `title`, `company`, `description`, requirements |
| InterviewSession | `id`, `ownerId`, context snapshot/version, language, stage, model ID, status, expiry |
| TranscriptTurn | `id`, `sessionId`, `source`, `speaker`, text, finality, audio time range, sequence |
| Suggestion | `id`, `questionId`, `generationId`, outline, optional detail/STAR, evidence IDs, status, actual model |
| InterviewReview | transcript references, candidate reflections, improvement topics, optional follow-up draft |

Use runtime schemas with explicit length, size, enum, and ownership checks. Interviewer speech, CVs, and job descriptions are untrusted context—not system instructions. Candidate experience claims must reference supplied evidence or clearly identify missing information. Assistant suggestions must never be confused with the candidate's spoken answers.

## Proposed HTTP and WebSocket contracts

Candidate-authenticated routes: `GET /api/v2/models`, `POST /api/v2/interviews`, `GET /api/v2/interviews/:id`, `POST /api/v2/interviews/:id/end`, `DELETE /api/v2/interviews/:id`, and `POST /api/v2/ws-ticket`. Create/update context through validated session APIs. Add save/export routes only with Phase 7 storage and ownership controls. Electron performs credential-bearing HTTP operations through specific IPC methods, not an unrestricted proxy.

Use `/ws/v2` alongside existing `/ws`. Negotiate protocol version and capabilities before capture. A proposed JSON event envelope is:

```json
{
  "version": 2,
  "type": "suggestion.completed",
  "sessionId": "opaque-session-id",
  "eventId": "unique-event-id",
  "sequence": 42,
  "payload": {
    "questionId": "turn-7",
    "generationId": "generation-3",
    "outline": ["Connect your relevant project to this requirement"],
    "evidenceIds": ["experience-2"]
  }
}
```

Client commands include start/resume, context update, audio chunk, pause, regenerate, model selection, and end. Server events include ready, transcript partial/final, generation started/delta/completed/cancelled, model change, recoverable error, and session ended. Define acknowledgements and idempotency before implementation; use per-source audio sequence numbers separately from server event sequence numbers.

Persist a bounded replay buffer of committed events. Resume requires authenticated ownership plus last acknowledged sequence. Replayed commands must not generate duplicate paid requests. Missing audio is a visible gap, not fabricated continuity. After the resume window expires, offer a new session explicitly.

Start with bounded JSON/base64 audio for compatibility. Introduce binary frames only after both ends negotiate them and measurements justify the change.

## Storage defaults

Proposed pilot defaults: 120-second disconnect resume window, two-hour active lease renewed by authorized activity, and 24-hour maximum ephemeral session retention. Explicit end closes capture and model work, generates the debrief if requested, then purges ephemeral state after a bounded review window. No raw audio storage by default. Save history only through an explicit candidate action. Phase 7 selects durable storage and deletion behavior; a checkpointer is not a substitute for a product history database.
