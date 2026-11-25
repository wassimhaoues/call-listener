# Backend Service

The backend is an ES-module Node service in `Call_listener_Backend/server/`. `server/index.js` starts Express and an independent `ws` server. Use `server/core/logger/` for structured, rotating logs; application logs are written under `logs/`.

## HTTP API

| Method and path | Purpose |
| --- | --- |
| `GET /health` | Returns service and Redis client status. |
| `POST /auth/token` | Accepts `{ "app_id", "device_id" }`; validates both, returns `{ "token", "expires_in" }`, and sets the `call_token` secure cookie. |
| `GET /auth/me` | Validates `call_token` and returns its JWT claims. |

Tokens are signed with issuer `call-backend` and audience `call-electron`. The WebSocket server accepts the token in `?token=` or the `call_token` cookie, then verifies its audience, issuer, application ID, and device ID. Invalid connections close with code `4001`.

## Integrations and data

`DeepgramService` uses the `nova-3` live model with `linear16`, 48 kHz mono audio, French language, interim results, VAD, and utterance boundaries. `StreamManager` limits generated replies to one at a time and uses an 800 ms cooldown and a 12-second model timeout.

Redis stores JSON conversation entries in a list and context as JSON. Groq uses `openai/gpt-oss-120b`; prompt construction is in `services/ai/promptBuilder.js`. Prompts and responses should remain concise and French unless product requirements change.

See [the WebSocket contract](protocols/websocket.md) before changing client or server message handling.
