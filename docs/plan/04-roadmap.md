# Phase-by-Phase Delivery Roadmap

Phase 0 is in progress; later phases are pending. Estimates and calendar commitments come after Phase 0 establishes the working baseline. Each phase should contain small reviewable changes, update the affected documentation, and demonstrate its exit gate before promotion.

Dependencies: **0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8**. Phase 3 screen mockups and Phase 5 layout work may proceed once their contracts are stable; integration still follows these gates.

## Phase 0 — Establish a reproducible baseline

Outcome: the current system can be rebuilt, exercised, and compared against later versions.

- [ ] Inventory source, configuration names, package locks, existing binaries, audio assets, and release identifiers without copying credentials.
- [x] Establish a recoverable source snapshot/version-control baseline; preserve all existing files. Record installer provenance separately from the source build. Git repository published to GitHub (2026-11-25); third-party Windows binaries are fetched in CI from upstream with recorded hashes rather than committed.
- [x] Verify the current Node/package compatibility and run an isolated LangChain/LangGraph/OpenRouter construction test; exact backend package versions are locked. Windows build prerequisites still need a supported Windows machine.
- [ ] Record Ubuntu 24.04/PipeWire as the Linux target and run the Linux baseline from [Linux desktop support](08-linux-support.md).
- [x] Replace placeholder checks with a backend test harness and renderer tests using Vitest/React Testing Library. Extend them with mocked provider adapters, fake WebSocket clients, and disposable Redis coverage.
- [ ] Capture fixtures for context, mic/system audio, transcripts, suggestions, malformed messages, authentication failures, and end/close behavior.
- [ ] Measure current speech-to-transcript, transcript-to-reply, CPU/memory, message rate, and provider usage on a named Windows test machine and synthetic interview recordings.
- [ ] Record the candidate-only product scope, initial French/English requirement proposal, deployment endpoint, and model cost envelope.

Exit gate: repeatable clean install/build, documented Windows happy path and restore behavior, baseline fixtures, real passing checks, and a known-issues list. Do not treat the remaining placeholder lint command as verification.

Rollback: no intended runtime behavior change; restore the baseline manifests/tooling if harness setup affects packaging.

## Phase 1 — Stabilize sessions, capture lifecycle, and access

Depends on Phase 0. Outcome: a reliable foundation before provider and UI changes.

- [x] Make stream creation single-flight per source and attach listeners after successful stream initialization. Bounded startup buffering remains pending.
- [x] Make stop/close idempotent, cancel pending model work, clear timers, and reject late results after end. **Complete 2026-11-26:** stop/close is idempotent, aborts active provider work, and suppresses late reply output; the introductory suggestion has its own lifecycle (superseded by a newer context, aborted on end, close, and disconnect, never sent late), covered by `test/sessionReplay.test.js` and `test/resumableSessions.test.js`.
- [ ] Add stable opaque IDs, owner binding, TTLs, bounded queues, and explicit session states. **Partially complete:** chat/context records now have a two-hour expiry and bounded chat turns; opaque resumable IDs, owner binding, queues, states, and the v2 protocol remain. **Update 2026-11-26:** 128-bit opaque session IDs, owner binding to JWT app/device, explicit active/disconnected/ended/expired states, bounded replay buffer, and a per-owner disconnected-session cap are implemented for `resume`-capable clients; the v2 protocol and tickets remain.
- [ ] Replace raw model HTML rendering with safe text/Markdown. **Partially complete:** safe text rendering, context validation, 64 KiB audio/128 KiB WebSocket limits, liveness/readiness, and metadata-only transcript logs are implemented. Rate limits remain. **Update 2026-11-26:** Redis-backed rate limits now cover `/auth/token` (per client behind a trusted proxy hop), `/ws-ticket`, and preparation; per-interview spend and call ceilings bound live generation.
- [ ] For the controlled pilot, enroll installations with revocable credentials stored in the OS credential facility; a hostname and public app ID cannot establish ownership. **Partially complete:** the desktop now uses a persisted random installation ID and cookie-authenticated WebSocket URL, but it is not account authentication or credential enrollment yet. Single-use WebSocket tickets and operator revocation of an installation ID (Redis deny-list enforced on every HTTP route and the socket, desktop revoked screens) are in place; a revoked user can still regenerate the installation ID, so OS-credential enrollment remains.
- [x] Exclude all `.env*` files from the container build context, document runtime secret injection, and test the Docker ignore rule. A deployment-image inspection remains a release check.
- [ ] Audit audio restoration through stop, tray toggle, suspend/resume, crash, and quit. Preserve the original playback snapshot until restoration succeeds. **Update 2026-11-26:** 9 real VB-Cable scenarios on a Windows runner cover stop, crash watchdog, recovery, startup, suspend/resume, tray toggles, overlapping power events, and quit; physical-device and real OS suspend checks remain.
- [x] Extract platform capability checks so Linux reaches the candidate workspace without running Windows-only routing, installer, or watchdog code. Renderer tests and source checks pass; live Electron validation remains in the Linux workstream.

Exit gate: repeated start/stop and stream-start races pass; foreign sessions/tickets are rejected; ended sessions emit no new suggestions; Windows restoration tests pass. Transcription remains available if AI fails.

Rollback: disable v2 access and new sessions while draining existing sessions; retain security and lifecycle fixes that pass regression tests. Do not expose legacy enrollment publicly as a rollback shortcut.

## Phase 2 — Introduce OpenRouter and model selection

Depends on Phase 1. Outcome: the candidate can choose a supported model without editing code.

- [x] Introduce a provider-independent AI service and migrate context-intro and reply generation through it.
- [x] Implement the LangChain OpenRouter adapter with streaming, AbortSignal propagation, deadline, bounded retries, normalized errors, and usage accounting. **Partially complete:** the non-streaming LangChain adapter accepts propagated `AbortSignal`, enforces a configurable 10-second request deadline, returns normalized provider errors, caps output at 600 tokens, and records reported token usage against the approved session ceiling. One minimal controlled preflight passed with the selected model; live streaming, safe idempotent retries, and multi-scenario provider validation remain. **Update 2026-11-26:** streaming with usage aggregated from chunks is implemented; safe retries remain. **Done 2026-11-26:** bounded safe retries ([design](provider-retries.md)) complete the adapter.
- [x] Add conditional provider configuration; OpenRouter mode does not require `GROQ_API_KEY`.
- [x] Serve a cached allowlisted model catalog and add the initial model picker to the current UI. Display unavailable models and reject unsupported selections server-side.
- [ ] Make model choice session-scoped, model changes apply to the next request, and cross-model fallbacks explicit. Enforce per-session request/token/spend limits. **Partially complete:** the selected model is stored in the session context, validated against the allowlist, pinned per generation, and re-read for each request; replies report selected and actual model IDs. There is no cross-model fallback. Per-model spend pricing and request limits remain. **Update 2026-11-26:** per-model pricing (`OPENROUTER_MODEL_PRICES`) and a per-interview call ceiling (`MAX_INTERVIEW_MODEL_CALLS`, alongside `MAX_INTERVIEW_COST_USD`, both counted atomically) are implemented; a cross-model fallback is deliberately absent.
- [x] Test invalid keys, 429s, timeouts, removed models, unsupported parameters, cancellation, incomplete streams, and missing usage metadata. **Complete 2026-11-26:** provider fixtures and retry tests cover each failure (`test/providerFixtures.test.js`, `test/providerRetries.test.js`, streaming abort/deadline tests); a reply cut at the output-token cap is now detected from `finish_reason` and marked `truncated` on the `done` generation, with a desktop hint.

Exit gate: at least two model IDs pass controlled end-to-end checks; selected and actual IDs are visible; provider failure leaves audio/transcription intact; old-client final-response behavior still works.

Rollback: explicitly select the temporary Groq adapter for legacy-compatible sessions, or use transcription-only mode. Do not silently transfer an interview to another provider.

## Phase 3 — Replace generic call context with candidate/job preparation

Depends on Phase 2. Outcome: the app understands the candidate and the specific job opportunity.

- [x] Add versioned CandidateProfile, JobOffer, interview settings, and evidence schemas. Validated context is accepted through the existing session protocol; a dedicated preparation API remains pending.
- [x] Replace Caller/Me forms with Candidate → Job Offer → Interview Settings → Audio Check. Language and answer-length settings are included; model selection waits for the model catalog.
- [x] Accept typed/pasted CV and job-description content, show extracted facts for correction, and build experience-to-requirement references. Initial extraction is local and deterministic; raw pasted CV text is not persisted or sent to the backend, and all extracted facts remain editable before a session begins.
- [ ] Produce candidate introduction, relevant STAR examples, practice topics, and questions to ask the interviewer using bounded prompts. **Partially complete:** the candidate can generate a local, reviewable brief from approved facts without a model call; a separately controlled model-backed preparation flow remains pending.
- [x] Import compatible old localStorage data only after candidate confirmation; never reinterpret generic caller details as candidate achievements. Preserve the original data until migration succeeds. Legacy context is backed up locally before its safe draft fields are copied into the editable candidate/job form.
- [x] Make transcription language and answer language explicit; test English/French profiles instead of silently inheriting French-only prompts. The preparation form carries separate validated values, and Deepgram stream startup uses the selected transcription language.

Exit gate: a candidate can prepare two distinct job applications with isolated context; output reflects the correct candidate/job and contains no invented experience in the evaluation fixtures.

Rollback: hide the new preparation flow for new sessions and retain versioned data for re-entry. Do not send the new schema into the old generic prompt builder.

## Phase 4 — Add the LangGraph interview workflow

Depends on Phase 3. Outcome: relevant, context-aware assistance driven by completed interviewer questions or candidate actions.

- [x] Implement the graph described in [target architecture](03-target-architecture.md) with bounded state, validated node inputs/outputs, and versioned prompts. **Partially complete:** a tested two-node LangGraph workflow owns grounded suggestion generation and selects bounded candidate-approved evidence; richer state validation and prompt versioning remain. **Complete 2026-11-26:** the workflow validates its input, the evidence-selection output, and the suggestion with zod before and between nodes (failures carry paths only, never transcript text); `PROMPT_VERSION` names the live templates, a fingerprint test forces a bump on any template change, and evaluation reports record it.
- [ ] Distinguish interviewer questions from acknowledgements; include preceding candidate answers and job evidence. Handle multipart and follow-up questions. **Partially complete:** a tested French/English fast-path classifier preserves acknowledgements in history but prevents them from triggering a generation, and the graph selects relevant job-evidence references; richer multipart/follow-up interpretation remains.
- [x] Replace busy/cooldown drops with a bounded scheduler: keep transcript events, cancel or supersede obsolete generations, and answer the latest relevant question. The tested scheduler keeps transcript history, aborts obsolete active work, and emits only the latest relevant response.
- [ ] Add outline/detail/STAR responses, clarification help, and evidence references. Use explicit missing-evidence behavior. **Partially complete:** the response-length setting now instructs a grounded short, outline/evidence, or detailed STAR output; evidence references and missing-evidence behavior are in the prompt. Candidate controls and rendered response sections remain.
- [x] Stream validated candidate-facing content through generation IDs; suppress stale output and avoid duplicate completion on retries or resume. Opt-in `stream` capability: per-session generation IDs, 50 ms batched deltas, no output after supersede/end, final `ai_reply` replaces streamed text (2026-11-26).
- [x] Keep the fast path to one generation call where possible; perform summaries/preparation outside the critical path. Bound total model calls, tokens, graph steps, and repair attempts. **Complete 2026-11-26:** each answer is one model call through a fixed two-node graph; preparation and the debrief run outside the live path with at most one repair; output tokens are capped per request; `MAX_INTERVIEW_MODEL_CALLS` and `MAX_INTERVIEW_COST_USD` bound each interview.
- [ ] Evaluate graph output against a simple interview-aware LangChain chain on identical fixtures. Adopt checkpointing only with a proven recovery requirement and tested backend. **Update 2026-11-26:** offline harness with 26 synthetic questions ([evaluation](evaluation.md)); fake-provider gate passes after follow-up evidence inheritance; a capped live run and human review remain.

Exit gate: grounding, question relevance, cancellation, context isolation, and latency gates pass; the graph demonstrably improves usefulness without an unacceptable latency/cost increase.

Rollback: route new generations to the simple interview-aware chain with the same inputs/output contract and selected OpenRouter model. Keep candidate-specific behavior intact.

## Phase 5 — Deliver the live candidate workspace

Depends on Phase 4. Outcome: a usable interview product, not a renamed generic conversation page.

- [x] Extract capture, socket lifecycle, transcript state, and generation state from `Conversation.jsx` into tested services/hooks.
- [ ] Build panels for current interviewer question, concise answer outline, relevant experience, expandable detail, and transcript. Clearly distinguish spoken candidate answers from generated suggestions. **Partially complete:** the live workspace has separate current-question, safe-guidance, relevant-experience, and transcript panels; detail expansion and explicit answer-outline sections remain.
- [ ] Add pause/resume, stop, shorten/expand, regenerate, model selection, and clarification actions, with keyboard access and readable focus states. **Partially complete:** keyboard-accessible pause/resume and stop controls are present; pause stops outgoing audio chunks without ending the session. The remaining response/model controls are pending.
- [x] Display connecting, ready, listening, thinking, reconnecting, incomplete, and transcription-only states. Retain useful previous output without implying it answers the newest question. **Partially complete:** connecting, ready, listening, paused, backend-confirmed thinking, and terminal guidance-unavailable states are shown; stale guidance is hidden while the current question is generating. Reconnecting/incomplete state handling remains. **Complete 2026-11-26:** reconnecting, connection lost, installation disabled, audio-gap and restarted-session notices, a truncated-answer hint (`truncated` on `done`), and transcription-only states (guidance unavailable, budget reached, model unavailable) are shown; stale guidance is cleared when a new generation starts.
- [ ] Make capture active only during an interview; stopping releases media tracks and audio routing through an explicit lifecycle. Closing to tray must preserve clear active-session behavior. **Partially complete 2026-11-26:** capture starts on the live page and Stop / Stop and review / capture failure release tracks and the audio context (tested); closing to the tray mid-interview now shows an "interview in progress" tray status and a one-time notification, the window closes (quits) instead of hiding when there is no tray (Linux), and relaunching shows a hidden window. Physical-device confirmation that routing restores on every exit path remains (see Phase 1 audio audit).
- [x] Handle blocked permissions, missing devices, empty context, unsupported platforms, unavailable models, and refresh/re-entry cleanly. **Partially complete:** microphone-only mode now provides a bounded typed interviewer-question fallback; permission, unavailable-model, and re-entry flows remain. **Complete 2026-11-26:** denied, missing, and busy devices get specific capture errors and release the session; a missing device selection returns to Setup; an unavailable model shows its own alert; unsupported platforms get `/unsupported`; and re-entry or a reload of the live page without a usable saved context (missing, corrupted, legacy) goes to `/context` before any socket or microphone is opened.
- [ ] Deliver Linux microphone-only mode while PipeWire system-audio capture follows its dedicated gates.

Exit gate: a candidate completes prepare → device check → live interview → stop on Windows; controls behave correctly during model/network failure; keyboard and rendering tests pass.

Rollback: use the simpler candidate workspace built in Phase 3 with the same v2 protocol. Keep the new feature hidden if its backend capability is unavailable.

## Phase 6 — Improve audio, response speed, and reconnection

Depends on Phase 5. Outcome: measured improvements under realistic long interviews and poor networks.

- [ ] Measure batching options (initial candidates: 20/40/60 ms) against current per-render-block messages. Preserve PCM format and verify actual device sample rates/resampling. **Partially complete:** the AudioWorklet uses a 20 ms linear16 batch with a Stop flush; real-device sample-rate and latency comparison remain.
- [x] Add bounded audio buffers and WebSocket backpressure. **Partially complete:** the renderer caps its WebSocket audio queue at 512 KiB and visibly counts newly dropped chunks during congestion. Control-message priority, interval reporting, and reconnect-session protection remain. **Complete 2026-11-26:** only audio is subject to the 512 KiB gate, so control messages (context, typed questions, actions, end) are never dropped behind audio; the drop counter is reported at intervals in the status bar; audio captured while reconnecting is dropped rather than queued, and the server reports the gap on resume.
- [ ] Add interim transcript UI, utterance deduplication, startup/final-buffer handling, and endpoint tuning. Generate from completed questions initially; speculative replies require separate evidence of benefit. **Update 2026-11-26:** opt-in interim frames and duplicate-final suppression are implemented; endpoint tuning and startup/final-buffer handling remain.
- [ ] Reconnect with bounded jittered backoff, fresh tickets, stable owner/session identity, and event replay. Restore context/model choice without duplicating paid generation. **Update 2026-11-26:** jittered reconnect (0.5–8 s, 120 s window), fresh URL per attempt, owner-checked resume with sequenced replay, no duplicate paid generation, and audio-gap notices are implemented on `/ws` for `resume`-capable clients; tickets and context/model restore across a new session remain.
- [x] Compare binary framing against batched base64; add it only if the gain justifies a new negotiated transport capability. **Complete 2026-11-26:** synthetic benchmark (`npm run bench:framing`) shows binary saves about 26% of upload (2.1 → 1.5 Mbit/s for two channels) with negligible CPU difference; base64 JSON is kept until real-device measurements show backpressure drops ([audio framing](audio-framing.md)).
- [x] Benchmark context trimming, prompt caching where supported, and optional summary scheduling. Preserve evidence and candidate corrections. **Complete 2026-11-26:** synthetic replay (`npm run bench:prompts`) shows requests level off near 4,600 input tokens with the 40-entry history, about 39% of input is a reusable cached prefix in the current layout, and summaries are not needed; the bound and layout are kept ([prompt growth](prompt-growth.md)).

Exit gate: Phase 0 measurements improve or stay within agreed tolerances; slow-network, reconnect, 60-minute soak, sleep/wake, and physical-device tests pass.

Rollback: independently revert batching size/transport capability or endpoint tuning. Resume compatibility stays available; do not couple performance tuning to a schema rollback.

## Phase 7 — Candidate debrief and controlled persistence

Depends on Phase 6. Outcome: the candidate can learn from and optionally retain their interview.

- [x] Generate a review from actual spoken transcript, clearly separating AI suggestions from statements the candidate made. Unsaved debrief with Markdown export (2026-11-26).
- [ ] Add questions covered, self-review notes, evidence-based improvement topics, and editable follow-up drafts; do not automate external messages.
- [ ] Offer save/export/delete. Select durable storage through an architecture decision: local encrypted storage for a single-device product, or authenticated backend storage for account-based sync. Implement one initially, not both.
- [ ] Apply owner isolation, retention, backup/deletion behavior, and schema migration tests. Saved history must not depend on ephemeral Redis keys or an in-memory graph checkpointer.
- [ ] Add document upload/parsing only as a separately gated extension with size/type limits, extraction review, and candidate-controlled deletion.

Exit gate: the candidate can reopen an explicitly saved review, export it, and delete associated records; unsaved sessions expire and cross-owner access fails.

Rollback: stop new saves/reviews while preserving existing saved data in a readable schema; provide export/delete without requiring the new AI workflow.

## Phase 8 — Qualify and release incrementally

Depends on Phase 7 for the full release; a limited live-interview pilot may ship after Phase 6 passes its gates.

- [ ] Run the complete [validation matrix](05-validation-and-rollout.md), including supported old/new client combinations.
- [ ] Verify clean Windows installation, upgrade, app identity/user-data continuity, driver handling, tray behavior, uninstall audio restoration, and updater configuration.
- [ ] Complete Linux AppImage/`.deb` qualification before claiming Linux support.
- [ ] Deploy backend capabilities first with flags off, then the desktop pilot, then enable compatible features for the pilot cohort.
- [ ] Monitor latency, error rate, stale output, restoration failures, and actual cost; rehearse rollback using the retained installer/container versions.
- [ ] Update current-system docs to match shipped behavior. Retire Groq/legacy endpoints only after the client-support window and migration gates are satisfied.

Exit gate: candidate workflow and operational gates pass, rollback is demonstrated, and release notes identify supported versions and known limitations. “No breaking changes” is verified against the compatibility matrix, never assumed.

Rollback: stop cohort expansion, disable the failing capability for new sessions, drain active sessions, and redeploy the last compatible backend/client versions. Preserve saved records and the protocol support window; use transcription-only mode when provider recovery is unavailable.
