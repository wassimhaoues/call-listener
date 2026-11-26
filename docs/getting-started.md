# Getting Started

## Prerequisites

Use Node.js 22.12 or newer and npm for workspace development and tests. The backend supports Node 20 or newer (the current container image uses Node 20), while the current frontend test tooling requires Node 22.12 or newer. Install Redis for a live backend. Windows audio uses VB-Cable and SoundVolumeView; Ubuntu 24.04/PipeWire is an in-progress Linux workstream. Deepgram and Groq credentials are required for the current live conversation pipeline.

## Backend setup

```bash
cd Call_listener_Backend
npm ci
npm run dev
```

Create a local `.env` from your secret manager. It must define `DEEPGRAM_API_KEY`, `REDIS_URL`, `APP_ID`, `JWT_SECRET`, and `JWT_TTL_SECONDS`. Set `AI_PROVIDER=groq` with `GROQ_API_KEY`, or set `AI_PROVIDER=openrouter` with `OPENROUTER_API_KEY`. The OpenRouter default is `openai/gpt-5.6-luna`; `GROQ_MODEL` and `OPENROUTER_MODEL` can override the provider model. `OPENROUTER_ALLOWED_MODELS` is an optional comma-separated list of OpenRouter model IDs the candidate may pick in the desktop app; it defaults to `OPENROUTER_MODEL` alone and must include it. `OPENROUTER_CATALOG_TTL_MS` (default `600000`) controls how long OpenRouter model availability is cached. `PORT` defaults to `4000` (WebSocket) and `EXPRESS_PORT` defaults to `3000` (HTTP). `APP_ID` must equal the desktop app ID (`com.coworky.calllistener`).

Start Redis before the backend. `GET http://localhost:3000/health` is a liveness check; use `GET http://localhost:3000/ready` for a dependency-aware readiness check.

## Desktop setup

```bash
cd Call_Listener_Frontend/v-0
npm ci
npm run dev
```

The Vite renderer runs at `127.0.0.1:5173`; Electron starts after its guarded `/__ping` endpoint is ready. In development, `npm run dev` connects to the local backend at `http://127.0.0.1:3000` and `ws://127.0.0.1:4000/ws`; the backend's development cookie is host-only and non-secure. Production defaults to `call.coworky.org` over HTTPS/WSS with secure cookies. Set `CALL_HOST`, `CALL_PROTOCOL`, `CALL_PORT`, `CALL_WS_PROTOCOL`, and `CALL_WS_PORT` only for a compatible explicit endpoint; set the same `ELECTRON_KEY` for Electron and Vite if overriding it in development.

## Local full-stack run

The checked-in Redis URL is for the container network, so start an isolated local Redis instance first (choose a development-only password):

```bash
docker run --rm --name call-listener-local-redis -p 127.0.0.1:6380:6379 redis:7-alpine redis-server --requirepass local-development-only --save '' --appendonly no
```

In a second terminal, run the backend with a localhost-only override; this does not change `.env`:

```bash
cd Call_listener_Backend
REDIS_URL='redis://default:local-development-only@127.0.0.1:6380' npm run dev
```

In a third terminal, start the desktop client:

```bash
cd Call_Listener_Frontend/v-0
npm run dev
```

Stop all three processes with `Ctrl+C` when finished. Do not use the sample password outside local development.

## Model budget defaults

OpenRouter sessions default to `MAX_INTERVIEW_COST_USD=5`, `OPENROUTER_MAX_OUTPUT_TOKENS=600`, and `OPENROUTER_REQUEST_TIMEOUT_MS=10000`. The server records provider-reported input/output token usage per ephemeral session and stops future suggestions after the cost ceiling. `OPENROUTER_INPUT_USD_PER_MILLION_TOKENS=0.2` and `OPENROUTER_OUTPUT_USD_PER_MILLION_TOKENS=1.2` are the configured prices for the initial model; update those values with an approved model-price change before switching models. Do not enable automatic provider retries until requests have an idempotency design.

The optional model-backed preparation brief (OpenRouter mode only) uses `PREPARATION_DAILY_BUDGET_USD` (default `0.50` per installation per 24 hours; `0` disables it), `PREPARATION_MAX_OUTPUT_TOKENS` (default `2000`), `PREPARATION_REQUEST_TIMEOUT_MS` (default `20000`), and `PREPARATION_RATE_LIMIT_PER_MINUTE` (default `3`). It is priced with the same `OPENROUTER_*_USD_PER_MILLION_TOKENS` values. See [Backend service](backend.md#preparation-brief).

For a distributable Windows installer, run `npm run build`. Do not edit `dist/`, the installer, or bundled tools in `bin/` by hand.

## Verification checklist

1. `GET /health` reports `status: "ok"` and Redis reaches `ready`.
2. Electron obtains an auth token and opens the setup page.
3. Choose distinct microphone and system-audio devices.
4. Start a conversation; both meters move, transcripts arrive, and suggestions appear.

## Automated checks

Run the automated checks before changing runtime behavior:

```bash
cd Call_listener_Backend && npm test
cd ../Call_Listener_Frontend/v-0 && npm test
npm exec vite build
```

The backend uses Node's test runner; the desktop project uses Vitest and React Testing Library. The backend lint command is still a placeholder. Also complete the relevant live verification flow, especially for audio routing and Electron packaging.
