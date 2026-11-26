# Implementation Status

Last updated: 2026-11-25.

| Phase | Status | Evidence |
| --- | --- | --- |
| 0 — Baseline | In progress | Portable backend and frontend test commands are implemented. AI-framework compatibility and Linux baseline checks are underway. Synthetic, provider-free backend fixtures and deterministic session replays are in place ([fixtures](fixtures.md)). Windows/Linux install, recorded-audio fixtures, and real-device measurement gates remain. |
| 1 — Foundations | In progress | Safe rendering, session expiry, stream lifecycle, and provider-request cancellation are implemented and tested; access and Windows-restoration gates remain. |
| 2 — OpenRouter | In progress | OpenRouter is locally configured with the selected model, cancellation, a 10-second request deadline, a 600-token output cap, and reported-usage accounting against the $5 session ceiling; one controlled live preflight passed, while streaming, model policy, retries, and multi-model validation remain. |
| 3 — Candidate preparation | In progress | Local CV/job-description extraction, editable requirements, evidence references, a reviewable preparation brief, confirmed legacy migration, and explicit French/English answer/transcription languages are implemented; model-backed preparation remains. |
| 4 — LangGraph workflow | In progress | The bounded graph receives only classified interviewer questions, selects up to three relevant approved evidence references, and uses a latest-question-wins scheduler; streaming and evaluation gates remain. |
| 5 — Live candidate workspace | In progress | The live screen separates the current interviewer question, safe candidate guidance, and approved relevant experience from the transcript; pause/resume, thinking/listening states, and a typed-question fallback for microphone-only mode are implemented, while reconnect and remaining controls remain. |
| 6 — Audio/performance | In progress | The AudioWorklet batches linear16 PCM into 20 ms chunks with a stop-time flush, and the client bounds queued WebSocket audio at 512 KiB; real-device latency, interval reporting, and reconnect gates remain. |
| 7–8 | Not started | See [roadmap](04-roadmap.md) for dependencies and exit gates. |

## Completed work in Phase 0

- Added backend unit tests for the current prompt builder.
- Added backend HTTP integration tests for health, token validation/issuance, cookie-based token verification, and injected runtime dependencies.
- Added frontend unit tests for the SoundVolumeView CSV parser used by Windows audio routing.
- Replaced the backend placeholder test command with Node's built-in test runner and added Vitest/React Testing Library to the frontend.
- Made the backend HTTP app accept injected Redis/config dependencies, allowing API tests to run without a real Redis instance or deployment credentials. Production startup passes the same real dependencies explicitly.
- Made the WebSocket boundary accept explicit configuration and an authenticated-connection handler. This adds isolated valid, missing, invalid, and cookie-token WebSocket authentication coverage without opening Redis or transcription connections.
- Made WebSocket message handling dependency-injected and added tests for candidate/job context, intro suggestions, audio normalization, session end, and malformed input. The production handler still supplies the existing Redis, transcription, and Groq services.
- Added a Linux support workstream for Ubuntu 24.04 with PipeWire alongside the Windows route.
- Installed pinned LangChain core `1.2.13`, LangGraph `1.4.18`, OpenRouter integration `0.4.15`, and Zod `4.6.5`; backend runtime support is now Node 20 or later because the LangChain core package requires it.
- Upgraded frontend tooling to Vite `8.3.1`, Vitest `5.0.2`, Electron `44.4.5`, electron-builder `26.15.3`, React Router `7.18.4`, Tailwind `4.3.3`, and Electron Updater `6.8.9`. Upgraded Lucide React to `1.48.0` to resolve a Vite 8 dependency-resolution build failure.
- Set the frontend development/test runtime requirement to Node `>=22.12`; the backend continues to support Node `>=20`.
- Cleared `npm audit` findings in both projects after the locked dependency upgrades.
- Added a pure, tested platform-capability module as the first Linux L0 artifact.
- Added a Linux-safe Electron startup branch: it skips VB-Cable/SoundVolumeView setup and reaches a tested microphone-only candidate setup flow when desktop audio is unavailable. Live Electron/PipeWire capture remains unqualified.
- Removed unsafe HTML injection for live model suggestions. Suggestions now render as text, and the candidate/interviewer labels replace the former caller wording in the live UI. This is the safe-rendering portion of P1-01; Phase 1 is not complete.
- Made transcription stream creation single-flight and session close idempotent. Stop/close now aborts an active provider request and late replies are suppressed; the behavior is covered with provider-free stream lifecycle tests. Bounded startup buffering remains open.
- Replaced hostname-derived device IDs with persisted random installation IDs and removed bearer JWTs from desktop-generated WebSocket URLs. Cookie authentication remains the active route; installation identity is not account authentication or a revocable credential.
- Excluded every `.env*` file from the Docker build context, added an HTTP readiness endpoint, and documented liveness versus Redis-backed readiness.
- Added two-hour Redis expiry for session context and bounded chat history (40 turns), with testable storage adapters that ignore malformed stored entries.
- Added a provider-neutral AI generator with legacy Groq and LangChain/OpenRouter adapters. The backend can select OpenRouter through environment configuration without requiring `GROQ_API_KEY`; OpenRouter cancellation is propagated through LangGraph and the provider adapter. Reported token usage is stored per interview, replies are capped at 600 output tokens, and new generations stop after the approved $5 ceiling. Live streaming, model policy, and retries remain pending.
- Replaced the desktop caller/me form with a versioned Candidate Profile, Job Offer, and Interview Settings flow. Backend schemas bound field sizes and candidate-grounded prompts preserve a legacy payload fallback during migration.
- Added local-only CV fact extraction and job-requirement extraction to the preparation screen. Candidates review and edit the extracted skills, achievements, and requirements before starting; raw pasted CV text is not persisted in the interview payload. Evidence references only connect supplied candidate facts to job requirements, and are included in the bounded prompt.
- Added a local preparation brief with an introduction outline, evidence-backed STAR prompts, practice topics, and questions to ask. It uses only approved candidate/job data and makes no model call; model-backed preparation stays a separately controlled future enhancement.
- Added confirmed legacy-context import. Old caller/me records remain unchanged until the candidate imports them, are copied to `callContextLegacyBackup`, and only safe name/profile/call-detail draft fields are mapped; legacy data is never treated as an achievement.
- Made transcription language explicit and separate from answer language. The selected French or English value is validated in the interview context and used to open each Deepgram stream; changing it after capture starts is rejected to avoid mixing transcript languages.
- Added a bounded English/French interviewer-question classifier before live generation. Completed acknowledgements stay in transcript history but do not invoke the graph or consume model budget.
- Added a deterministic LangGraph evidence-selection node. It compares the latest interviewer question with the candidate-approved evidence references and supplies at most three relevant references to the existing single generation call.
- Replaced busy/cooldown reply drops with a bounded latest-question-wins scheduler. A newer interviewer question aborts an obsolete generation; only the latest relevant response can reach the candidate.
- Made the answer-length setting part of the candidate prompt contract: short replies are speakable in at most three sentences, standard replies provide an outline and evidence, and detailed replies use an evidence-grounded STAR structure.
- Reworked the live guidance sidebar into candidate-facing sections for the current interviewer question, safe suggested answer, and relevant approved experience. The existing transcript remains separate, so generated guidance is not confused with spoken content.
- Added live pause/resume and generation status. Pause stops new audio chunks from being transmitted without destroying the session; the interface shows backend-confirmed thinking and returns to listening after a suggestion.
- Added the microphone-only typed interviewer-question fallback. It is shown only when system-audio capture is disabled, accepts at most 2,000 nonblank characters, and sends the question through the existing classifier, transcript, budget, and latest-question-wins workflow rather than opening a separate model path.
- Added an explicit current-question generation state: once a newer question is accepted, older guidance is hidden and the candidate sees that new guidance is being prepared. This prevents stale output from appearing to answer the current interviewer question.
- Added an explicit terminal generation-failure state. Empty or failed provider replies now finish the live guidance state instead of leaving it pending; the current client shows a transcription-preserving availability message, while the legacy error reply remains for older clients.
- Added a configurable 10-second OpenRouter request deadline and normalized provider timeout, abort, and request-failure codes. There are deliberately no automatic retries until paid-request idempotency is designed and tested.
- Ran one controlled local OpenRouter preflight against `openai/gpt-5.6-luna` using a 30-token cap. It completed within the deadline and reported 17 input and 7 output tokens; the API key was not logged or exposed. This is a connectivity/configuration check, not an end-to-end interview qualification.
- Batched AudioWorklet PCM from render-quantum messages into 20 ms linear16 chunks, with a final partial-chunk flush on Stop. This reduces message overhead by design; no live latency improvement is claimed until physical-device measurements are recorded.
- Added a tested 512 KiB WebSocket audio backpressure limit. When a slow network fills the outbound socket buffer, newly produced audio chunks are dropped and the candidate sees a visible limitation count instead of accumulating stale audio; control messages and reconnect behavior still need their dedicated protocol work.
- Added a bounded one-node LangGraph workflow to the live suggestion path. It has no autonomous agents or hidden extra model calls; richer evidence selection and graph state remain future gates.
- Changed default Deepgram utterance logs to source and character-count metadata only; full transcript text is no longer written to the default operational log path.
- Added an allowlisted, cached model catalog (`OPENROUTER_ALLOWED_MODELS`, authenticated `GET /models`) enriched from OpenRouter's public model list, with unavailable models flagged and `unknown` availability when the lookup fails. The Interview Settings step has an "AI model" picker fed through a narrow `getModels()` preload method; the backend rejects models outside the allowlist with `unsupported_model`. The choice is session-scoped and pinned per generation, and suggestion messages carry additive selected/actual model IDs. Per-model budget pricing, cross-model fallback policy, and in-call model switching UI remain.
- Added synthetic backend fixtures and a deterministic replay harness ([fixtures](fixtures.md)). Three scripted sessions (English two-channel, French, budget-exhausted) run through the real message handler, stream manager, Deepgram service, LangGraph workflow, OpenRouter adapter, stores, and budget, with only Deepgram, the provider client, Redis, and the WebSocket client faked. The tests assert the exact outbound message sequence, role mapping, acknowledgement skipping, latest-question-wins aborts, no output after end, usage/missing-usage accounting, and transcription surviving provider failures. Fixture tables also cover contexts, malformed frames, WebSocket authentication failures, and provider outcomes (success, empty, 429, timeout, abort, missing usage). Step durations are recorded only as diagnostics. These fixtures contain no recorded audio and no real-device or real-provider data.
- The replay work fixed three small backend bugs, each with a regression test. Evidence selection now matches a term that ends a sentence ("migration."). A context rejected for a mid-capture language change no longer replaces the stored context. The stream manager's default workflow now forwards provider usage to the budget. One known gap is recorded as a `todo` test: an intro suggestion can still be sent after `end`.

## Latest verification

Run on 2026-09-29 with Node `v24.11.1` and npm `11.10.0`:

| Command | Result |
| --- | --- |
| `cd Call_listener_Backend && npm test` (2026-11-25, Node `v24.11.1`) | Passed: 92 tests (91 pass, 1 documented `todo`), adding synthetic session replays and context, malformed-message, auth, and provider fixture tables. |
| `cd Call_listener_Backend && npm test` (2026-09-29) | Passed: 53 tests, including candidate/job validation, LangGraph workflow/evidence selection, question classification/latest-question scheduling, typed-question fallback, provider deadlines and terminal generation failures, secure-production/local-development cookie policy, session-cost accounting, HTTP/WebSocket authentication, message limits, stream lifecycle, explicit transcription language, transcript-log privacy, Docker secret-boundary, and readiness. |
| `cd Call_listener_Backend && npm audit` | Passed: 0 vulnerabilities. |
| `cd Call_Listener_Frontend/v-0 && npm test` | Passed: 27 tests (CSV parser, React button behavior, platform capabilities, safe suggestion rendering/live guidance and stale-output state, microphone-only setup and typed-question fallback, local/production authentication boundary behavior, candidate/job context, preparation extraction/brief generation, confirmed legacy migration, PCM-batch configuration, and WebSocket audio backpressure). |
| `cd Call_Listener_Frontend/v-0 && npm exec vite build` | Passed: production renderer build. |
| Controlled OpenRouter preflight | Passed: `openai/gpt-5.6-luna` returned within the configured deadline with 17 input and 7 output tokens under a 30-token cap. No key or transcript was printed. |
| `cd Call_Listener_Frontend/v-0 && npm run build` | Passed: renderer build and Linux AppImage package. |
| `cd Call_Listener_Frontend/v-0 && npm exec electron-builder -- --linux deb` | Passed: produced a validated `amd64` `.deb` with application metadata and desktop entry. This is not yet a qualified install test. |
| `cd Call_Listener_Frontend/v-0 && npm audit` | Passed: 0 vulnerabilities. |
| `cd Call_Listener_Frontend/v-0 && npm exec electron -- --version` | Passed: Electron `v44.4.5` runs after the host sandbox ownership/mode correction. |
| `cd Call_Listener_Frontend/v-0 && npm start` | Electron launches after the sandbox correction, but production authentication correctly stops at TLS verification because there is no active `call.coworky.org` deployment. No TLS bypass was used. Development now has an explicit localhost HTTP/WS route for local work. |
| Local full stack | Passed with a disposable Redis container: backend readiness, HTTP token issuance, cookie-authenticated local WebSocket handshake, and Electron development authentication all completed without an audio or model request. |

## Remaining Phase 0 gates

- Run and record clean backend/frontend build and Windows desktop install/audio restoration results on a supported Windows system.
- Add recorded synthetic-audio fixtures and measurable baseline latency, CPU, memory, message-rate, and usage data from a named Windows test machine. Synthetic WebSocket/provider/transcript fixtures and replays now exist ([fixtures](fixtures.md)); they are not measurements.
- Add the model allowlist, provider deadlines/retries/usage controls, and controlled non-production provider checks before exposing a model picker or shipping the live provider.
- Establish the requested recoverable source snapshot/version-control baseline outside this checkout, which has no `.git` metadata.

## Live provider configuration

- OpenRouter is enabled locally with `openai/gpt-5.6-luna`, selected for reliable, latency-sensitive interview assistance. The API key remains local and is never committed or printed.
- The approved ceiling is **USD 5 per interview**. Server-side enforcement now uses provider-reported usage and a 600-token output cap; live provider validation and any model-price change require a fresh approved cost review.

Phase 0 will be marked **Done** only after every remaining gate is evidenced. No later phase will be marked done early.
