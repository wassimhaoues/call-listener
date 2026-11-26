# Candidate Interview Assistant — Enhancement Plan

Status: active implementation plan. Phase 0 is in progress; see [implementation status](STATUS.md) for verified work and remaining gates.
Prepared: 2026-09-29.

## Product direction

**The candidate is the user.** Transform the generic call assistant into a job-interview assistant that helps a candidate prepare, answer questions using their own experience, and learn afterward. The interviewer is the remote speaker, never the customer or operator of an interviewer dashboard. Candidate ranking, hiring recommendations, and interviewer assessment tools are outside this project.

Use OpenRouter for selectable language models, LangChain for model integration and prompt composition, and LangGraph for controlled interview workflows. Preserve Windows audio capture and the existing desktop/backend boundary while migrating incrementally.

## Read in this order

1. [Product scope and candidate journey](01-product-scope.md)
2. [Current implementation and migration risks](02-current-state.md)
3. [Target architecture and contracts](03-target-architecture.md)
4. [Phase-by-phase delivery roadmap](04-roadmap.md)
5. [Validation, performance, and rollout](05-validation-and-rollout.md)
6. [First implementation sprint](06-first-sprint.md)
7. [Decisions and technical references](07-decisions-and-references.md)
8. [Linux desktop support](08-linux-support.md)
9. [Implementation status](STATUS.md)
10. [Backend fixtures and session replay](fixtures.md)
11. [Offline evaluation of live suggestions](evaluation.md)
12. [Provider retries and request idempotency](provider-retries.md)
13. [Audio framing: base64 JSON vs binary frames](audio-framing.md)
14. [Prompt growth, context trimming and prompt caching](prompt-growth.md)
15. [Baseline inventory](inventory.md)

## Delivery sequence

| Phase | Outcome |
| --- | --- |
| 0 | Reproducible baseline and regression harness |
| 1 | Reliable session lifecycle and safe foundations |
| 2 | OpenRouter integration and selectable models |
| 3 | Candidate/job context and preparation workflow |
| 4 | LangGraph-powered interview assistance |
| 5 | Complete live candidate workspace |
| 6 | Faster audio and reconnect behavior |
| 7 | Candidate debrief and optional saved history |
| 8 | Windows and Linux release qualification and staged rollout |

Each phase has an exit gate and a rollback path. Start with Phase 0; do not combine the provider switch, session rewrite, and UI replacement in one release. Detailed UI design can progress alongside backend work once contracts are agreed.

## Working assumptions

Windows remains the initial supported desktop platform; Ubuntu 24.04/PipeWire is the Linux target under the separate workstream. Interviews run in the candidate's existing meeting/call application; built-in dialing, SIP, and video conferencing are not part of this migration. Deepgram remains the initial speech provider. Typed or pasted CV and job-offer content comes before document uploads. Exact model IDs, operating costs, and performance improvements must be measured during implementation.
