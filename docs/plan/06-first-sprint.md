# First Implementation Sprint

Purpose: complete Phase 0 and prepare the smallest safe Phase 1 changes. The Phase 0 harness, framework-compatibility spike, dependency audit, and first Linux capability module have started; unchecked items remain the active backlog.

## Ordered work items

| ID | Task | Likely files/area | Acceptance |
| --- | --- | --- | --- |
| P0-01 | Inventory and recoverable baseline | Root, both package manifests/locks, release configuration | Source snapshot identified; configuration names listed without secrets; existing artifacts preserved |
| P0-02 | Reproduce backend and Windows client | Dockerfile, desktop package/build config | Clean backend run, renderer build, Windows install/run, audio restore results recorded |
| P0-03 | Add backend regression harness | New backend test fixtures and package scripts | **In progress:** HTTP and WebSocket authentication plus context/audio/end/malformed-message handling are exercised without runtime services; stream races and provider mocks remain. |
| P0-04 | Add renderer regression harness | New frontend tests and package scripts | Device selection, context entry, transcript roles, stop/unmount, and generated-content rendering covered |
| P0-05 | Capture timing and interview fixtures | New synthetic fixtures and baseline report | At least one complete two-channel replay plus latency, CPU, memory, and message-rate baseline |
| P0-06 | Prove AI package compatibility | Isolated backend spike | Pinned Node/LangChain/LangGraph/OpenRouter versions; stream/abort/schema behavior documented; no credentials committed |
| P0-07 | Finalize v2 contracts and pilot identity | Schema/contract proposal and fixtures | Owner binding, role mapping, ticket exchange, stop/resume, and model choice reviewed against old-client behavior |
| P1-01 | Fix safe rendering and lifecycle boundaries | `Conversation.jsx`, stream/session services | **Partially complete:** model suggestions now render as text with a regression test; idempotent stop and late-reply suppression remain. |

## Suggested change sequence

1. Baseline report, fixture data, and real test tooling.
2. Targeted safety/lifecycle fixes with failing-then-passing regression tests.
3. Provider abstraction preserving current Groq behavior behind the existing contract.
4. OpenRouter adapter and model picker only after Phase 1's access/session gates pass.

The isolated AI framework stack is installed and covered by construction/graph tests; it is not wired into live requests yet. Preserve existing package/runtime boundaries and avoid a frontend redesign until the dependent Phase 1–4 contracts pass.

## Decisions to record before dependent work

- **Confirmed:** the candidate is the user. Interviewers only supply remote speech/context.
- **Default scope:** Windows first; existing external call apps; pasted candidate/job text first.
- **Languages:** proposed French and English, with explicit transcription and answer-language settings.
- **Provider budget:** deployment owner supplies the allowable model list and spend limits before live provider evaluation; mocked tests can proceed independently.
- **Identity:** enrolled installations are the proposed pilot boundary; account login is needed before multi-device cloud history.
- **Saved history:** choose local or account-backed storage before Phase 7, without blocking the live MVP.

## Sprint completion evidence

Record actual commands and outcomes, runtime versions, fixture IDs, Windows hardware/audio devices, timings, failed cases, and remaining blockers in a new baseline report under this folder. Avoid claiming the application is regression-safe until the desktop/audio checks have been run on Windows.

The next implementation actions are the remaining Phase 0 baseline evidence: Windows build/install/audio verification, representative audio/WebSocket/provider fixtures, and performance measurements. The roadmap remains the authority for later phase gates.
