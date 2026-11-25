# Validation, Performance, and Rollout

## Evidence required

Tests and metrics below are planned, not completed. Phase 0 records the baseline and sets the reference machine, network conditions, model IDs, provider route, concurrency, and fixture versions. Use synthetic candidate data and recorded test audio; provider-connected evaluations are opt-in and budgeted.

## Test matrix

| Layer | Checks |
| --- | --- |
| Unit | Runtime schemas; candidate/interviewer role mapping; evidence selection; prompt budgets; model allowlist; PCM conversion; timeout/abort; scheduler ordering |
| Provider contract | Complete/streamed output; valid and invalid credentials; rate limits; unsupported parameters; model removal; fallback metadata; abort and partial failures |
| Backend integration | Disposable Redis; TTL/deletion; ownership; v1/v2 sockets; ticket reuse; concurrent starts; replay/idempotency; provider failure without transcription loss |
| Graph | Branches; follow-up/multipart questions; missing evidence; stale output; bounded repair; checkpoint recovery only if configured |
| React | Preparation validation; model picker; streamed suggestion lifecycle; safe rendering; role labels; keyboard navigation; reconnect and empty/error states |
| Windows desktop | Both inputs; unplug/replug; permissions; repeat start/stop; tray; suspend/resume; crash/watchdog; saved playback restoration; clean install and upgrade |
| Load/soak | 60-minute interview; slow/disconnected clients; provider slowdown; Redis outage; baseline, expected pilot peak, and twice-peak simulated concurrency |
| Data handling | No keys/JWTs/full transcripts in default logs; no `.env.*` in images; owner separation; end/expiry/delete across all configured stores |

Implemented Phase 0 scripts: backend `test`, `test:unit`, `test:integration`, and `test:framework`; frontend `test` and `test:unit`. `npm exec vite build` is the current renderer-only build check. The backend lint script remains a placeholder and frontend lint is not configured. Keep the real Windows packaging check as a separate release qualification step.

## Quality evaluation

Build at least 30 synthetic scenarios spanning recruiter, behavioral, technical, follow-up, and ambiguous questions, with French/English examples and varied experience levels. Include missing achievements, irrelevant context, and instruction-like text inside a job description. Keep a held-out subset for release qualification.

Review answer relevance, factual grounding in candidate evidence, concision, language, and whether suggestions are distinguishable from spoken answers. Proposed gate: no invented candidate facts in the fixed suite, valid output schemas in all contract tests, and at least 90% of sampled answers judged useful by a human reviewer using a written rubric. This is a finite test gate, not a guarantee about every future model answer.

Compare models and the graph/simple-chain variants on identical inputs. Record model ID, actual route, prompt/graph version, token usage, latency, and reviewer result. Do not select a default solely from a provider's advertised model ranking.

## Performance targets

Initial targets below require Phase 0 calibration; do not promise them for every selectable model.

| Metric | Proposed target and measurement |
| --- | --- |
| End of speech → final transcript | p95 ≤ 1.5 seconds on the reference setup; report endpointing separately |
| Accepted final question → first useful visible answer | p50 ≤ 1.5 seconds, p95 ≤ 3 seconds for the chosen live-model preset |
| Accepted question → completed concise answer | p95 ≤ 6 seconds; slower models must be visibly identified |
| End of speech → first useful answer | Measure directly; do not add independent percentile numbers |
| Stop response | Media capture stops within 500 ms locally; cancelled work cannot update UI/history |
| Reconnect | Resume within 10 seconds of restored connectivity while within the grace window |
| Long-session behavior | No unbounded queues/history/checkpoints; memory settles rather than growing with session duration |
| Cost | Report LLM and transcription costs separately per 30-minute fixture; enforce the configured per-session budget |

Exclude UI spinners, empty tokens, reasoning tokens, and unvalidated JSON from “first useful answer.” Track errors/cancellations in the denominator and report sample size. If a model misses the live target, keep it available for preparation/debrief or label it slower.

## Compatibility and rollback

| Combination | Expected behavior |
| --- | --- |
| Legacy client + migration backend | Existing context/audio/final-reply protocol works during the support window |
| New client + migration backend | v2 capabilities negotiated; candidate interview features enabled selectively |
| New client + old backend | Detect missing capabilities before starting; offer an explicit legacy mode only if maintained, otherwise a clear compatible-server requirement |
| In-flight session + feature flag change | Finish on its pinned workflow/schema or end cleanly; no mid-generation provider/schema switch |

Use separate switches for provider adapter, interview workflow, graph, new workspace, and binary audio. Store schema and workflow versions with sessions. Use additive migrations; preserve rollback-readable records until old-client support ends. A rollback must not silently reinterpret candidate records as legacy caller data.

Roll out backend first, then a small Windows pilot, then expand after measured acceptance. Never automatically duplicate real interview traffic to two providers for comparison; use fixtures for side-by-side evaluations.

Rollback triggers include audio restoration failure, cross-session data access, duplicate paid requests, dropped accepted final turns, unsafe output rendering, and material regression against agreed latency/error limits. Retain the previous deployable backend image and installer. For provider incidents, expose transcription-only mode with a visible error and bounded retry.
