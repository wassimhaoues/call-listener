# WebSocket Protocol

The desktop client connects to `wss://<host>/ws` after obtaining a token from the HTTP API. Chromium supplies the `call_token` secure cookie, keeping the bearer token out of renderer-visible URLs and URL logs. The backend temporarily accepts `?token=<jwt>` for legacy clients only. A connection without a token closes with code `4001` and reason `auth_required`; an invalid token closes with `4001` and `auth_failed`. A connection receives heartbeat pings every 30 seconds; clients should allow normal WebSocket pong handling.

## Client messages

| Message | Shape | Notes |
| --- | --- | --- |
| Context | `{ "context": { ... } }` | Stored for the session. The current legacy payload uses `caller.*` and `me.*`; it will be replaced by versioned candidate/job-offer fields in Phase 3. The server immediately returns an introductory suggestion. Versioned contexts may set an optional `settings.model` to an ID from `GET /models`; omit it to use the server default. A model outside the server allowlist is rejected with `{ "error": "unsupported_model" }` and the previous session context stays in effect. Sending a new context with a different model changes the model for the next generation only. |
| Audio | `{ "source": "mic"|"system", "chunk": "<base64>" }` | Chunk is mono, signed 16-bit little-endian PCM at 48 kHz. `chunk` may also be a byte array for non-browser clients. Decoded chunks are capped at 64 KiB; WebSocket messages are capped at 128 KiB. |
| End | `{ "end": true }` | Stops the active transcription streams. |

## Server messages

| Message | Shape | Meaning |
| --- | --- | --- |
| Transcript | `{ "speaker": "you"|"caller", "transcript": "..." }` | A final Deepgram utterance. These are legacy wire labels: `mic`/`you` is shown as **Candidate** and `system`/`caller` as **Interviewer** in the desktop UI. |
| Suggestion | `{ "ai_reply": "...", "model"?: { "selected": "...", "actual": "..."|null } }` | Introductory or response suggestion. The additive `model` object reports the model the server requested and the model the provider says served it (`actual` is `null` when the provider omits it). Older clients can ignore it. |
| Error | `{ "error": "..." }` | Unsupported audio chunk, invalid message, `interview_budget_reached`, or `unsupported_model`. |

Audio messages are JSON, not binary WebSocket frames. The server parses every frame as JSON and accepts only `mic` and `system` source labels. Invalid or malformed messages receive `{ "error": "Invalid message" }` while the socket remains available. Send context before audio so suggestions include it, and send `end` before an intentional shutdown.
