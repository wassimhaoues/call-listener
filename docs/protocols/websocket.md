# WebSocket Protocol

The desktop client connects to `wss://<host>/ws` after obtaining a token from the HTTP API. Chromium supplies the `call_token` secure cookie, keeping the bearer token out of renderer-visible URLs and URL logs. The backend temporarily accepts `?token=<jwt>` for legacy clients only. A connection without a token closes with code `4001` and reason `auth_required`; an invalid token closes with `4001` and `auth_failed`. A connection receives heartbeat pings every 30 seconds; clients should allow normal WebSocket pong handling.

## Client messages

The server checks each frame in this order and handles the first match: `context`, `end`, `interviewer_question`, then audio.

| Message | Shape | Notes |
| --- | --- | --- |
| Context | `{ "context": { ... } }` | Stored for the session. The current legacy payload uses `caller.*` and `me.*`; it will be replaced by versioned candidate/job-offer fields in Phase 3. The server immediately returns an introductory suggestion. Versioned contexts may set an optional `settings.model` to an ID from `GET /models`; omit it to use the server default. A model outside the server allowlist is rejected with `{ "error": "unsupported_model" }` and the previous session context stays in effect. Sending a new context with a different model changes the model for the next generation only. If the interview budget is already spent, the context is stored but the server sends `{ "error": "interview_budget_reached" }` instead of the introductory suggestion. |
| Audio | `{ "source": "mic"|"system", "chunk": "<base64>" }` | Chunk is mono, signed 16-bit little-endian PCM at 48 kHz. `chunk` may also be a byte array for non-browser clients. Decoded chunks are capped at 64 KiB (larger ones receive `{ "error": "Audio chunk too large" }`); WebSocket messages are capped at 128 KiB. |
| Typed interviewer question | `{ "interviewer_question": "..." }` | Fallback when interviewer (system) audio is unavailable, e.g. Linux microphone-only mode. The text is trimmed and must be 1–2,000 characters, otherwise the frame is answered with `{ "error": "Invalid message" }`. The server treats it exactly like a final interviewer utterance: it is stored in history, echoed back as a `caller` transcript, and, if it is classified as a question, scheduled for generation (latest question wins). Ignored after `end`. |
| End | `{ "end": true }` | Stops the active transcription streams and any in-flight generation; later utterances and late replies are suppressed. |

The desktop client stops a session in this order: ask each audio worklet to flush its partial batch, wait (at most 250 ms) for that final audio chunk and send it, send `{ "end": true }`, then close the socket.

## Server messages

| Message | Shape | Meaning |
| --- | --- | --- |
| Transcript | `{ "speaker": "you"|"caller", "transcript": "..." }` | A final Deepgram utterance, or the echo of a typed interviewer question (`caller`). These are legacy wire labels: `mic`/`you` is shown as **Candidate** and `system`/`caller` as **Interviewer** in the desktop UI. |
| Generation thinking | `{ "generation": { "state": "thinking" } }` | Sent when a generation for the latest interviewer question starts (after the budget check, before the model call). Clients should hide the previous suggestion so stale guidance is not shown as the answer to the new question. A newer question aborts the in-flight generation; the superseded one sends nothing further, and the newer one sends its own `thinking`. |
| Generation failed | `{ "generation": { "state": "failed" }, "ai_reply": "[Erreur du modèle]" }` | Terminal for the current question: the model returned no text, timed out, or the pipeline failed. Transcription keeps running. `ai_reply` is retained only for older clients; clients that understand `generation` must prefer the failure state over the reply text. Not sent for superseded generations. |
| Suggestion | `{ "ai_reply": "...", "model"?: { "selected": "...", "actual": "..."|null } }` | Introductory or response suggestion. The additive `model` object reports the model the server requested (`selected`) and the model the provider says served it (`actual`, `null` when the provider omits it). It is present when the provider reported model information; older clients can ignore it. The desktop client shows it under the suggestion as `Model: <actual or selected>`, naming both when they differ. |
| Budget reached | `{ "error": "interview_budget_reached" }` | The interview's reported model cost reached `MAX_INTERVIEW_COST_USD`. Sent instead of generating, either for the introductory suggestion or for an interviewer question. Transcription continues; no further suggestions are generated for this interview. |
| Unsupported model | `{ "error": "unsupported_model" }` | The context's `settings.model` is not in the server allowlist. The context is rejected (no introductory suggestion) and the previous session context, if any, stays in effect. The desktop client tells the candidate to pick another model in Interview Settings. |
| Other errors | `{ "error": "..." }` | `Invalid message`, `Unsupported audio chunk type`, or `Audio chunk too large`. The socket remains open. |

Audio messages are JSON, not binary WebSocket frames. The server parses every frame as JSON and accepts only `mic` and `system` source labels. Invalid or malformed messages receive `{ "error": "Invalid message" }` while the socket remains available. Send context before audio so suggestions include it, and send `end` before an intentional shutdown.
