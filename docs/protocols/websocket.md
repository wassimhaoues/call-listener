# WebSocket Protocol

The desktop client connects to `wss://<host>/ws` after obtaining a token from the HTTP API. Chromium supplies the `call_token` secure cookie, keeping the bearer token out of renderer-visible URLs and URL logs. The backend temporarily accepts `?token=<jwt>` for legacy clients only. A connection without a token closes with code `4001` and reason `auth_required`; an invalid token closes with `4001` and `auth_failed`. A connection receives heartbeat pings every 30 seconds; clients should allow normal WebSocket pong handling.

## Client messages

The server checks each frame in this order and handles the first match: `context`, `end`, `interviewer_question`, then audio.

| Message | Shape | Notes |
| --- | --- | --- |
| Context | `{ "context": { ... } }` | Stored for the session. The current legacy payload uses `caller.*` and `me.*`; it will be replaced by versioned candidate/job-offer fields in Phase 3. The server immediately returns an introductory suggestion. Versioned contexts may set an optional `settings.model` to an ID from `GET /models`; omit it to use the server default. A model outside the server allowlist is rejected with `{ "error": "unsupported_model" }` and the previous session context stays in effect. Sending a new context with a different model changes the model for the next generation only. If the interview budget is already spent, the context is stored but the server sends `{ "error": "interview_budget_reached" }` instead of the introductory suggestion. A context may also list optional client capabilities in a top-level `capabilities` array (for example `{ "context": { "version": 1, ..., "capabilities": ["stream"] } }`); see [Streamed suggestions](#streamed-suggestions). A context whose `version` the server does not implement is rejected with `{ "error": "unsupported_context_version" }`. |
| Audio | `{ "source": "mic"|"system", "chunk": "<base64>" }` | Chunk is mono, signed 16-bit little-endian PCM at 48 kHz. `chunk` may also be a byte array for non-browser clients. Decoded chunks are capped at 64 KiB (larger ones receive `{ "error": "Audio chunk too large" }`); WebSocket messages are capped at 128 KiB. |
| Typed interviewer question | `{ "interviewer_question": "..." }` | Fallback when interviewer (system) audio is unavailable, e.g. Linux microphone-only mode. The text is trimmed and must be 1–2,000 characters, otherwise the frame is answered with `{ "error": "Invalid message" }`. The server treats it exactly like a final interviewer utterance: it is stored in history, echoed back as a `caller` transcript, and, if it is classified as a question, scheduled for generation (latest question wins). Ignored after `end`. |
| End | `{ "end": true }` | Stops the active transcription streams and any in-flight generation; later utterances and late replies are suppressed. |

The desktop client stops a session in this order: ask each audio worklet to flush its partial batch, wait (at most 250 ms) for that final audio chunk and send it, send `{ "end": true }`, then close the socket.

## Server messages

| Message | Shape | Meaning |
| --- | --- | --- |
| Transcript | `{ "speaker": "you"|"caller", "transcript": "..." }` | A final Deepgram utterance, or the echo of a typed interviewer question (`caller`). These are legacy wire labels: `mic`/`you` is shown as **Candidate** and `system`/`caller` as **Interviewer** in the desktop UI. |
| Generation thinking | `{ "generation": { "state": "thinking" } }` (streaming clients: `{ "generation": { "id": "...", "state": "thinking" } }`) | Sent when a generation for the latest interviewer question starts (after the budget check, before the model call). Clients should hide the previous suggestion so stale guidance is not shown as the answer to the new question. A newer question aborts the in-flight generation; the superseded one sends nothing further, and the newer one sends its own `thinking`. |
| Generation streaming | `{ "generation": { "id": "...", "state": "streaming" }, "delta": "..." }` | Streaming clients only. The next piece of the current generation's suggestion text; append it to the text received so far for that ID. See [Streamed suggestions](#streamed-suggestions). |
| Generation failed | `{ "generation": { "state": "failed" }, "ai_reply": "[Erreur du modèle]" }` (streaming clients: `generation` also carries `id`) | Terminal for the current question: the model returned no text, timed out, or the pipeline failed. Transcription keeps running. `ai_reply` is retained only for older clients; clients that understand `generation` must prefer the failure state over the reply text. Not sent for superseded generations. |
| Suggestion | `{ "ai_reply": "...", "model"?: { "selected": "...", "actual": "..."|null } }` (streaming clients, for live generations: plus `"generation": { "id": "...", "state": "done" }`) | Introductory or response suggestion. The additive `model` object reports the model the server requested (`selected`) and the model the provider says served it (`actual`, `null` when the provider omits it). It is present when the provider reported model information; older clients can ignore it. The desktop client shows it under the suggestion as `Model: <actual or selected>`, naming both when they differ. |
| Budget reached | `{ "error": "interview_budget_reached" }` | The interview's reported model cost reached `MAX_INTERVIEW_COST_USD`. Sent instead of generating, either for the introductory suggestion or for an interviewer question. Transcription continues; no further suggestions are generated for this interview. |
| Unsupported context version | `{ "error": "unsupported_context_version" }` | The context declares a `version` other than `1` (legacy contexts omit `version`). The context is rejected: nothing is stored, no introductory suggestion is generated, and the previous session context, if any, stays in effect. |
| Unsupported model | `{ "error": "unsupported_model" }` | The context's `settings.model` is not in the server allowlist. The context is rejected (no introductory suggestion) and the previous session context, if any, stays in effect. The desktop client tells the candidate to pick another model in Interview Settings. |
| Other errors | `{ "error": "..." }` | `Invalid message` (including a context with a malformed `capabilities` list), `Unsupported audio chunk type`, or `Audio chunk too large`. The socket remains open. |

Audio messages are JSON, not binary WebSocket frames. The server parses every frame as JSON and accepts only `mic` and `system` source labels. Invalid or malformed messages receive `{ "error": "Invalid message" }` while the socket remains available. Send context before audio so suggestions include it, and send `end` before an intentional shutdown.

## Streamed suggestions

Streaming is opt-in. A client advertises it by listing `"stream"` in the top-level `capabilities` array of its context message. `capabilities` must be an array of at most 8 strings of 1–32 characters; otherwise the whole context frame is rejected with `{ "error": "Invalid message" }` and nothing is stored. Unknown capability names are ignored. Capabilities describe the client, not the interview: they are not stored with the session context and never reach a model.

The most recently accepted context decides. Sending a context without `"stream"` downgrades the session to the legacy messages. Each generation keeps the setting it started with, so a change applies from the next generation.

For a streaming client, each live (interviewer-question) generation has an opaque string `id`, unique within the session. Clients must only compare it for equality. It produces, in order:

1. `{ "generation": { "id": "g7", "state": "thinking" } }` — exactly once, before the model call.
2. Zero or more `{ "generation": { "id": "g7", "state": "streaming" }, "delta": "..." }`. Deltas are raw candidate-facing text (whitespace included). They are coalesced on the server and sent at most every ~50 ms. Reasoning or other non-text model output is never streamed.
3. Exactly one terminal message:
   - `{ "ai_reply": "...", "model"?: {...}, "generation": { "id": "g7", "state": "done" } }`. `ai_reply` is the complete, trimmed suggestion and **replaces** the streamed text. Any pending delta is sent before it.
   - or `{ "generation": { "id": "g7", "state": "failed" }, "ai_reply": "[Erreur du modèle]" }`. Discard any streamed text for that ID. A reply that is empty after trimming is a failure, never `done`.

Ordering guarantees:

- Messages for one generation arrive in the order above, and nothing for that ID follows its terminal message.
- A generation superseded by a newer interviewer question (latest question wins), stopped by `end`, or ended by socket close sends nothing further: no delta, no terminal message. The newer generation then sends its own `thinking` with a new `id`. Clients should ignore any `streaming`, `done`, or `failed` message whose `id` is not the current generation's. For example, a client that submits a typed question can ignore deltas for the previous ID until the new `thinking` arrives.
- Transcript messages may arrive between generation messages.
- When the provider cannot stream (Groq rollback mode), a streaming client receives `thinking`, then the terminal message, with no deltas.

Not streamed: the introductory suggestion sent after a context, and `interview_budget_reached` errors. Both keep their existing shape, with no `generation` object.

Compatibility: clients that do not advertise `"stream"` receive exactly the legacy messages (`{ "generation": { "state": "thinking" } }`, `{ "ai_reply": ... }`, and the failure shape, with no `id` and no deltas). Servers older than this feature ignore the unknown `capabilities` key and send the legacy messages, which streaming clients must continue to handle.
