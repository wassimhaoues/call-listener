# Baseline inventory

Roadmap Phase 0 asks for an inventory of source, configuration names, package locks, existing binaries, audio assets, and release identifiers, without copying credentials. This page lists names and locations only. It never lists values of secrets. Recorded 2026-11-26 from `main`.

## Source

| Path | What it is |
| --- | --- |
| `Call_listener_Backend/` | Node ≥ 20 ES-module backend: Express API (`server/app.js`), `ws` WebSocket server, services, contracts, tests (`test/`), operator and benchmark scripts (`scripts/admin`, `scripts/bench`, `scripts/eval`). `Dockerfile` and `call-listener-stack.yml` (Docker Swarm + Traefik) deploy it. |
| `Call_Listener_Frontend/v-0/` | Electron desktop client (Node ≥ 22.12): main process (`main.js`, `preload.js`, `services/`), React renderer (`src/`), Vitest tests (`test/`), CI scripts (`scripts/ci/`), packaging assets (`build/`). |
| `docs/` | Current-system docs, protocols, and the plan (`docs/plan/`). |
| `.github/workflows/` | `ci.yml` (every PR) and `release.yml` (tag-triggered draft release). |

## Configuration names

Backend environment variables, read in `server/config/env.js` unless noted. Secrets are marked; their values live only in the deployment's secret store or a local, git-ignored `.env`.

- **Secrets:** `DEEPGRAM_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `JWT_SECRET`, and `REDIS_URL` (it may embed a password).
- **Identity and HTTP:** `APP_ID`, `EXPRESS_PORT` / `PORT`, `COOKIE_DOMAIN`, `COOKIE_SECURE`, `JWT_TTL_SECONDS`, `TRUST_PROXY_HOPS`, `NODE_ENV`, `LOG_TO_FILE` (logger).
- **Providers:** `AI_PROVIDER`, `GROQ_MODEL`, `OPENROUTER_MODEL`, `OPENROUTER_ALLOWED_MODELS`, `OPENROUTER_MODEL_PRICES`, `OPENROUTER_INPUT_USD_PER_MILLION_TOKENS`, `OPENROUTER_OUTPUT_USD_PER_MILLION_TOKENS`, `OPENROUTER_MAX_OUTPUT_TOKENS`, `OPENROUTER_REQUEST_TIMEOUT_MS`, `OPENROUTER_MAX_RETRIES`, `OPENROUTER_CATALOG_TTL_MS`.
- **Budgets and limits:** `MAX_INTERVIEW_COST_USD`, `MAX_INTERVIEW_MODEL_CALLS`, `AUTH_RATE_LIMIT_PER_MINUTE`, `WS_TICKET_RATE_LIMIT_PER_MINUTE`, `WS_TICKET_TTL_SECONDS`, `PREPARATION_DAILY_BUDGET_USD`, `PREPARATION_MAX_OUTPUT_TOKENS`, `PREPARATION_RATE_LIMIT_PER_MINUTE`, `PREPARATION_REQUEST_TIMEOUT_MS`.
- **Sessions and revocation:** `RESUME_WINDOW_MS`, `MAX_DISCONNECTED_SESSIONS_PER_OWNER`, `WS_ALLOW_COOKIE_AUTH`, `REVOCATION_FAIL_CLOSED`, `REVOCATION_SWEEP_MS`.

Desktop environment variables (development and CI only; a packaged build uses its defaults): `CALL_HOST`, `CALL_PORT`, `CALL_PROTOCOL`, `CALL_WS_PORT`, `CALL_WS_PROTOCOL`, `NODE_ENV`, `ELECTRON_KEY` (dev-server header key, generated per run), `ELECTRON_RUN_AS_NODE` (audio watchdog child), `CRASH_CHILD` (CI audio scenarios), `PROCESSOR_ARCHITEW6432` (Windows architecture detection). Evaluation runs also read the opt-in variables documented in [evaluation](evaluation.md#cost-guard).

`docs/getting-started.md` and `docs/deployment.md` document defaults and valid ranges. `env.js` validates them at startup.

## Package locks

| Project | Lockfile | Runtime | Notable dependencies |
| --- | --- | --- | --- |
| Backend | `Call_listener_Backend/package-lock.json` | Node ≥ 20 | `@deepgram/sdk` 4.x, `@langchain/core`, `@langchain/langgraph`, `@langchain/openrouter`, `express`, `ws`, `ioredis`, `jsonwebtoken`, `zod` 4, `winston` (+ daily rotate), `groq-sdk` (rollback) |
| Desktop | `Call_Listener_Frontend/v-0/package-lock.json` | Node ≥ 22.12, Electron 44 | `electron-updater`; the renderer libraries (React, React Router, Tailwind, Vite) are dev dependencies bundled at build time |

CI installs both with `npm ci --ignore-scripts`. The Electron binary is fetched by an explicit step.

## Binaries and downloaded tools

Nothing executable is committed. `v-0/bin/`, `dist/` and `*.zip` are git-ignored.

| Tool | Where it comes from | Integrity | Shipped as |
| --- | --- | --- | --- |
| SoundVolumeView (NirSoft, x64) | `https://www.nirsoft.net/utils/soundvolumeview-x64.zip` | SHA-256 checked against a reviewed list in `scripts/ci/fetch-windows-deps.ps1` (unsigned upstream; `-Strict` fails on an unreviewed hash) | `bin/SoundVolumeView.exe` via electron-builder `extraResources` |
| VB-Cable driver pack 45 (VB-Audio) | `https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip` | SHA-256 checked the same way | `bin/VB_Cable/` (installed on the candidate's request) |

## Audio and image assets

- No audio assets are committed. Tests use synthetic PCM (`silentPcmChunk`, deterministic pseudo-audio in `scripts/bench/audioFraming.js`), and CI audio scenarios use the VB-Cable device itself.
- Images: `v-0/build/icon.ico`, `icon.png`, `tray.ico` and `tray.png` (application and tray icons).

## Release identifiers

| Identifier | Value | Where | Notes |
| --- | --- | --- | --- |
| Desktop package name / version | `call-listener` / `1.0.0` | `v-0/package.json` | Tags drive `release.yml`. |
| Product name | `Call Listener` | `build.productName` | Installer and window title. |
| electron-builder `appId` | `org.coworky.calllistener` | `build.appId` | The Windows installer identity and the shortcut's AppUserModelID. Changing it would break upgrade continuity. |
| Windows AppUserModelID at runtime | `org.coworky.calllistener` | `services/appIdentity.js` | Must equal `build.appId` (guarded by `test/appIdentity.test.js`). Before 2026-11-26 the app set `com.coworky.calllistener`, which did not match the installed shortcut. |
| Backend application ID | `com.coworky.calllistener` | `services/appIdentity.js` (`AUTH_APP_ID`) and backend `APP_ID` | Public API identifier sent to `/auth/token`. It is not a credential and not an installation identity. |
| Installation identity | random per installation | `installation-id` in the Electron user-data directory | Sent as `device_id`; revocable server-side ([device revocation](../backend.md#device-revocation)). |
| Default backend host | `call.coworky.org` (HTTPS/WSS 443) | `main.js` | Overridable in development with `CALL_*` variables. |
| Backend package / version | `call_listener_backend` / `1.0.0` | `Call_listener_Backend/package.json` | Container image tags come from the deployment. |
| Build targets | Windows NSIS x64, Linux AppImage and `.deb` | `build.win`, `build.linux` | All three are built and smoke-tested on every PR. |
