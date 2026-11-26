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

OpenRouter sessions default to `MAX_INTERVIEW_COST_USD=5`, `OPENROUTER_MAX_OUTPUT_TOKENS=600`, and `OPENROUTER_REQUEST_TIMEOUT_MS=10000`. The server records provider-reported input/output token usage per ephemeral session and stops future suggestions after the cost ceiling, or after `MAX_INTERVIEW_MODEL_CALLS` (positive integer, default `400`) charged model calls, whichever comes first; the call cap bounds a session even on a cheap or mispriced model. Each call is charged at the price of the model that served it. `OPENROUTER_INPUT_USD_PER_MILLION_TOKENS=0.2` and `OPENROUTER_OUTPUT_USD_PER_MILLION_TOKENS=1.2` price the default model (`OPENROUTER_MODEL`). Every other model in `OPENROUTER_ALLOWED_MODELS` needs an entry in `OPENROUTER_MODEL_PRICES`, a JSON object of USD-per-million-token prices, for example `OPENROUTER_MODEL_PRICES={"anthropic/claude-sonnet-4.5":{"input":3,"output":15}}`; startup fails in OpenRouter mode if an allowlisted model has no price. An entry for the default model overrides the single-price pair. Update prices with an approved model-price change; the server logs a warning when a configured price is below OpenRouter's catalog price (see [Per-model pricing](backend.md#per-model-pricing)). `OPENROUTER_MAX_RETRIES` (integer `0`–`2`, default `1`; `0` disables retries) bounds how often a failed OpenRouter request is retried. Only failures that produced no completion and no streamed text are retried (429/502/503/504 or a refused connection), and all attempts share the request deadline (see [Provider retries](plan/provider-retries.md)).

The optional model-backed preparation brief (OpenRouter mode only) uses `PREPARATION_DAILY_BUDGET_USD` (default `0.50` per installation per 24 hours; `0` disables it), `PREPARATION_MAX_OUTPUT_TOKENS` (default `3000`), `PREPARATION_REQUEST_TIMEOUT_MS` (default `22000`), and `PREPARATION_RATE_LIMIT_PER_MINUTE` (default `3`). It is priced with the same per-model prices. See [Backend service](backend.md#preparation-brief).

WebSocket tickets: `WS_TICKET_TTL_SECONDS` (default `30`, 1–300) is how long a `POST /ws-ticket` ticket stays valid, `WS_TICKET_RATE_LIMIT_PER_MINUTE` (default `30`) limits ticket requests per installation, and `WS_ALLOW_COOKIE_AUTH` (`true` or `false`, default `true`) keeps accepting the JWT cookie or `?token=` on the socket for clients that do not use tickets yet. Tickets need Redis 6.2 or newer (`GETDEL`).

`POST /auth/token` allows `AUTH_RATE_LIMIT_PER_MINUTE` (default `20`) requests per client IP per minute. Set `TRUST_PROXY_HOPS` to the number of reverse proxies in front of Express (default `0`; `1` behind Traefik) so limits apply per client.

Installation enrollment: `ENROLLMENT_REQUIRED` (`true` or `false`, default `false`) decides whether `/auth/token` refuses installations that send no enrollment secret (see [Installation enrollment](backend.md#installation-enrollment)). Device revocation: `REVOCATION_FAIL_CLOSED` (`true` or `false`, default `false`) decides whether authentication is refused (`true`) or allowed with a logged warning (`false`) when Redis cannot answer the deny-list lookup, and `REVOCATION_SWEEP_MS` (default `60000`, 1000–3600000) is how often open sockets are re-checked. See [Device revocation](backend.md#device-revocation).

Resumable sessions (clients sending the `resume` capability) are held in process memory for `RESUME_WINDOW_MS` (default `120000`) after a disconnect, with at most `MAX_DISCONNECTED_SESSIONS_PER_OWNER` (default `3`) held per installation.

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
