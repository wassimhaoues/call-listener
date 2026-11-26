# Backend Service

The backend is an ES-module Node service in `Call_listener_Backend/server/`. `server/index.js` starts Express and an independent `ws` server. Use `server/core/logger/` for structured, rotating logs; application logs are written under `logs/`.

## HTTP API

| Method and path | Purpose |
| --- | --- |
| `GET /health` | Returns service and Redis client status. |
| `POST /auth/token` | Accepts `{ "app_id", "device_id" }`; validates both, returns `{ "token", "expires_in" }`, and sets the `call_token` secure cookie. |
| `GET /auth/me` | Validates `call_token` and returns its JWT claims. |
| `GET /models` | Requires a valid `call_token` cookie. Returns the allowlisted model catalog `{ provider, defaultModel, source, fetchedAt, models: [{ id, name, contextLength, pricing, availability, isDefault }] }`. |

## Model catalog and selection

`OPENROUTER_ALLOWED_MODELS` (comma-separated OpenRouter model IDs, at most 20) is the only source of selectable models; it defaults to `OPENROUTER_MODEL` alone and startup fails if it omits `OPENROUTER_MODEL`. `services/ai/modelCatalog.js` enriches the allowlist from OpenRouter's public `GET /api/v1/models` list (no key sent) with an in-memory cache (`OPENROUTER_CATALOG_TTL_MS`, default 10 minutes) and a 3-second lookup timeout. Models absent from the upstream list are returned with `availability: "unavailable"`; when the lookup fails, every allowlisted model is returned with `availability: "unknown"` and the lookup is retried after a minute. Stale data is served while a refresh runs, so the endpoint never blocks on OpenRouter after the first lookup. Upstream models outside the allowlist are never exposed. In `AI_PROVIDER=groq` mode the catalog is empty.

The candidate's choice travels as `settings.model` in the session context. The WebSocket handler rejects any model outside the allowlist (and any explicit model in Groq mode) with `{ "error": "unsupported_model" }` and keeps the previous session context. The selection is read from the session context for each generation, so a new context message changes the model for the next request only; an in-flight request keeps its pinned model. There is no cross-model fallback. The session budget still prices every model with `OPENROUTER_INPUT_USD_PER_MILLION_TOKENS` / `OPENROUTER_OUTPUT_USD_PER_MILLION_TOKENS`, so only allowlist models priced at or below those values until per-model pricing is implemented.

Tokens are signed with issuer `call-backend` and audience `call-electron`. The WebSocket server accepts the token in `?token=` or the `call_token` cookie, then verifies its audience, issuer, application ID, and device ID. Invalid connections close with code `4001`.

## Integrations and data

`DeepgramService` uses the `nova-3` live model with `linear16`, 48 kHz mono audio, French language, interim results, VAD, and utterance boundaries. `StreamManager` limits generated replies to one at a time and uses an 800 ms cooldown and a 12-second model timeout.

Redis stores JSON conversation entries in a list and context as JSON. Groq uses `openai/gpt-oss-120b`; prompt construction is in `services/ai/promptBuilder.js`. Prompts and responses should remain concise and French unless product requirements change.

See [the WebSocket contract](protocols/websocket.md) before changing client or server message handling.
