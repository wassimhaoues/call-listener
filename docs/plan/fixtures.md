# Backend Fixtures and Session Replay

Phase 0 (P0-03 / P0-05) regression coverage for the backend. Every fixture is **synthetic**: names, companies, achievements, transcripts, and token counts are invented, and nothing was recorded from a real interview, device, or provider. The replays prove message ordering and lifecycle behavior; they are **not** a latency, CPU, memory, or audio-quality baseline. Real-device measurements on a named Windows machine remain an open Phase 0 gate.

## Layout (`Call_listener_Backend/test/`)

| Path | Contents |
| --- | --- |
| `fixtures/contexts.json` | Valid English, French, and mixed-language candidate/job contexts; a legacy `caller`/`me` payload; invalid/oversized cases built from a base plus overrides; documented quirks (an unknown `version` currently parses as an empty legacy context). |
| `fixtures/sessions/*.json` | Scripted sessions as ordered steps. Each step lists the exact client messages it must produce, plus the provider response it consumes. A `final` block covers streams, stored context language, chat history, provider calls, usage, and spend. |
| `fixtures/malformedMessages.json` | Frames that must be rejected without opening a stream or calling a provider. |
| `fixtures/authFailures.json` | WebSocket authentication cases (missing, malformed, unsigned, wrong secret/issuer/audience, expired, foreign app, missing device) plus valid query/cookie controls. The signing secret is generated per run. |
| `fixtures/providerResponses.json` | ChatOpenRouter-shaped responses (success with usage, usage only in `response_metadata`, missing usage, empty, 429, hang for timeout/abort, deferred) and a case table of adapter and live-session outcomes. |
| `helpers/replayHarness.js` | Builds the same parts `connectionHandler.js` uses: the real message handler, stream manager, `DeepgramService`, LangGraph workflow, OpenRouter adapter, chat/context stores, and budget. Only the network edges are fakes. |
| `helpers/fakeDeepgram.js` | Fake `deepgramClient` whose live connection emits Deepgram-like `Results` (interim/final) and `UtteranceEnd` events. |
| `helpers/fakeProvider.js` | Fake `ChatOpenRouter` that plays back the fixture responses and honors abort signals. |
| `helpers/memoryRedis.js` | In-memory subset of the ioredis API (strings, lists, hashes, TTLs). |
| `helpers/replayMetrics.js` | Per-step duration recorder with an injectable clock. Durations are printed as test diagnostics and are never asserted against time limits. |

## Scripted sessions

- `en-two-channel-v1` covers an intro suggestion and a malformed frame mid-session. It also has a rejected mid-capture language change and interleaved mic/system interim+final transcripts. Other steps: an acknowledgement the classifier skips, a question superseded by a newer one (the obsolete generation is aborted and never shown), a typed question that gets a 429 (transcription continues), and a question still generating at `end`. After end, a late transcript, audio, and a typed question produce no output.
- `fr-behavioral-v1` uses a French transcription stream and French prompt. It includes `D'accord.` and `Merci.` acknowledgements and a question with no question mark.
- `en-budget-exhausted-v1` uses a USD 0.0005 ceiling. Once reported usage crosses it, questions and context resends get `interview_budget_reached` with no provider call, and transcription continues.

Step types: `context`, `audio` (silent PCM16 chunks of `bytes`), `transcript` (`isFinal` true/false), `utteranceEnd`, `typed`, `raw`, `end`. `waitFor: "providerPending"` holds the replay until a request is in flight, which makes supersede and end-while-generating deterministic. Waits are event-loop driven. There is only a 5-second guard against hangs, and no timing assertions. The production 800 ms reply cooldown is set to 0 in the harness.

## Running

```bash
cd Call_listener_Backend
npm test                                   # everything
npm run test:unit                          # includes sessionReplay, protocolFixtures, providerFixtures
npm run test:integration                   # includes authFailures.integration (opens a local port)
node --test test/sessionReplay.test.js     # replays only; step timings appear as diagnostics
```

`sessionReplay.test.js` contains one `todo` test: an intro suggestion that finishes after `end` is still sent, because the intro path has no lifecycle guard or abort signal yet (Phase 1). It is reported as todo and does not fail the suite.

## Adding a scenario

1. Add any new provider responses to `providerResponses.json`.
2. Copy a session file, keep the data synthetic, and list the exact `expect` messages for each step.
3. Add the path to `SESSIONS` in `test/sessionReplay.test.js`. A new test file must also be added to the explicit `package.json` script lists.
