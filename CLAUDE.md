# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Call Listener is a candidate-facing job-interview assistant: an Electron desktop client captures microphone and system audio, the backend transcribes it (Deepgram) and streams concise AI answer guidance back over WebSocket. See `AGENTS.md` for style/commit rules and `docs/` for detailed docs (`docs/plan/STATUS.md` is the most current record of what is implemented).

Public GitHub repo `wassimhaoues/call-listener` (default branch `main`; work on branches + PRs). Secrets, logs, `dist/`, `v-0/bin/` and the third-party `.zip` tools are git-ignored — never commit them. Two independent npm projects; run commands from each project dir.

## Commands

Backend (`Call_listener_Backend/`, Node >=20, ES modules):
- `npm run dev` / `npm start` — run `server/index.js` (needs `.env`: Deepgram, Redis, JWT, and Groq or OpenRouter keys).
- `npm test` — Node built-in runner. **Test files are listed explicitly in `package.json`**; a new test file must be added to the `test` script (and `test:unit` or `test:integration`) or it will not run.
- `npm run test:unit`, `npm run test:integration`, `npm run test:framework` (LangChain/LangGraph compatibility).
- Single test: `node --test test/streamManager.test.js` (add `--test-name-pattern="..."` to filter).
- `npm run lint` is a no-op placeholder.

Frontend (`Call_Listener_Frontend/v-0/`, Node >=22.12):
- `npm run dev` — Vite on 127.0.0.1:5173 + Electron (waits on `/__ping`). The Vite dev server rejects requests lacking the `x-electron-key` header, so the renderer is only reachable through Electron, not a browser.
- `npm test` — Vitest (jsdom, setup in `test/setup.js`, tests in `test/`). Single test: `npx vitest run test/Setup.test.jsx` or `-t "name"`.
- `npm run build` — Vite build into `dist/` then electron-builder (Windows NSIS; Linux AppImage/deb). `dist/` and `bin/` are generated/bundled — don't edit.

## CI (`.github/workflows/ci.yml`)
Every PR runs: backend+frontend tests on Ubuntu and Windows; Windows NSIS build → silent install/launch/uninstall smoke (`v-0/scripts/ci/smoke-installer.ps1`); real VB-Cable audio restoration scenarios (`v-0/scripts/ci/install-vbcable.ps1` + `audioRestore.cjs`, run with Electron in node mode); Linux deb/AppImage build + Xvfb launch (`smoke-linux.sh`). `fetch-windows-deps.ps1` downloads SoundVolumeView/VB-Cable (hash-checked; `-Strict` for releases). Use this instead of a local Windows machine; download job artifacts (screenshots, logs) with `gh run download`.

## Architecture

### Backend (`server/`)
- `index.js` wires real dependencies; `app.js` (`createApp({ redisClient, config })`) is the Express API (`/health`, readiness, `/auth/token`, `/auth/me`). `websocket/websocketServer.js` is a separate `ws` server; it authenticates with a single-use `?ticket=` from `POST /ws-ticket` (Redis `wsticket:<sha256>`, consumed with GETDEL; `services/auth/wsTicketStore.js`), or, while `WS_ALLOW_COOKIE_AUTH` is true, the JWT (issuer `call-backend`, audience `call-electron`) via `call_token` cookie or `?token=`; bad auth closes with code `4001`.
- **Dependency injection is the testing strategy**: app, WebSocket server, `messageHandler`, stream manager, stores, and AI generators all accept injected deps so tests run without Redis, Deepgram, or provider keys. Preserve this when adding services — pass deps in from `index.js` rather than importing singletons.
- Message flow: `websocket/handlers/messageHandler.js` handles context/settings, audio chunks (labelled `mic` / `system`, base64 PCM16 48 kHz mono), typed questions, `{ end: true }`. `services/transcription/streamManager.js` owns one Deepgram live stream per label (single-flight creation, idempotent close) and the **latest-question-wins scheduler**: a newer interviewer question aborts the in-flight generation; late replies are suppressed.
- Live generation pipeline: completed interviewer utterance → `services/interview/questionClassifier.js` (acknowledgements don't trigger generation) → `services/interview/interviewWorkflow.js` (bounded LangGraph: `selectEvidence` → `generateSuggestion`, max 3 evidence refs from `evidenceSelector.js`) → `services/ai/aiService.js` provider selector (`AI_PROVIDER=groq|openrouter`) → `promptBuilder.js`. `interviewBudget.js` tracks reported token cost per interview and stops generation at `MAX_INTERVIEW_COST_USD`. The OpenRouter adapter retries only failures that produced no usage and no streamed text (429/502/503/504, refused connections), at most `OPENROUTER_MAX_RETRIES` times inside the one request deadline; LangChain's own retries are disabled. See `docs/plan/provider-retries.md` before changing it.
- `contracts/interviewContext.js` validates the versioned candidate profile / job offer / interview settings payload (bounded sizes, answer vs. transcription language, legacy fallback). Transcription language can't change after capture starts.
- Redis (`services/chat/`): `chat:<sessionId>` (bounded to 40 turns) and `context:<sessionId>`, 2-hour expiry; purged on socket close for ordinary clients, or after the resume window (`RESUME_WINDOW_MS`) / explicit end for clients with the `resume` capability (sessions held in process memory, see `server/services/session/`).
- Logging: use `server/core/logger/`; default logs record transcript metadata (source, char counts), not transcript text — keep it that way.
- WebSocket message contract: `docs/protocols/websocket.md` — read before changing client or server message handling.

### Frontend (`v-0/`)
- Process boundary: Electron main (`main.js`, `services/`) owns auth (JWT stays in main), persisted random installation ID, OS audio routing (Windows: VB-Cable + SoundVolumeView via `bin/`), tray, auto-update. The renderer gets only what `preload.js` exposes on `window.callApi` (`getWsUrl`, `getPlatformCapabilities`, `getModels`, `getDiagnostics`, `generatePreparationBrief`, `setInterviewActive`); main-process audio goes through `services/platformAudio/` adapters (Windows VB-Cable wrapper, Linux mic-only). Never expose JWTs or provider credentials to React.
- `services/platformCapabilities.js` decides the flow: Windows uses system+mic capture; Linux skips VB-Cable setup and runs a microphone-only mode with a typed-question fallback.
- Renderer (`src/`, React + Tailwind + React Router): `pages/Setup.jsx`/`Context.jsx` build the candidate preparation (local-only CV/job extraction in `src/services/preparation.js`, no model call); `pages/Conversation.jsx` opens the socket and streams audio from `worklets/pcm-processor.js` (AudioWorklet batching 20 ms PCM16 chunks) with `src/services/audioBackpressure.js` dropping audio past 512 KiB buffered. Model suggestions render as text (`SuggestionText.jsx`) — never inject HTML.

## Docs upkeep
`docs/README.md` asks that the relevant `docs/` page be updated whenever a config variable, API/WebSocket message, deployment setting, or user-facing flow changes; `docs/plan/STATUS.md` tracks phase progress.
