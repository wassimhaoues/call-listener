# WebSocket Protocol

The desktop client connects to `wss://<host>/ws` after obtaining a token from the HTTP API. Chromium supplies the `call_token` secure cookie, keeping the bearer token out of renderer-visible URLs and URL logs. The backend temporarily accepts `?token=<jwt>` for legacy clients only. A connection without a token closes with code `4001` and reason `auth_required`; an invalid token closes with `4001` and `auth_failed`. A connection receives heartbeat pings every 30 seconds; clients should allow normal WebSocket pong handling.

## Client messages

The server checks each frame in this order and handles the first match: `resume` (first frame of a connection only), `context`, `end`, `action`, `interviewer_question`, then audio.

| Message | Shape | Notes |
| --- | --- | --- |
| Resume | `{ "resume": { "sessionId": "...", "lastSeq": 0 } }` | Resume-capable clients only, and only as the **first** frame on a new connection. `lastSeq` is the highest `seq` the client received (a non-negative integer). See [Resumable sessions](#resumable-sessions). A malformed resume frame receives `{ "error": "Invalid message" }`; a resume frame sent later on a connection is an invalid message too. |
| Context | `{ "context": { ... } }` | Stored for the session. The current legacy payload uses `caller.*` and `me.*`; it will be replaced by versioned candidate/job-offer fields in Phase 3. The server immediately returns an introductory suggestion. Versioned contexts may set an optional `settings.model` to an ID from `GET /models`; omit it to use the server default. A model outside the server allowlist is rejected with `{ "error": "unsupported_model" }` and the previous session context stays in effect. Sending a new context with a different model changes the model for the next generation only. If the interview budget is already spent, the context is stored but the server sends `{ "error": "interview_budget_reached" }` instead of the introductory suggestion. A context may also list optional client capabilities in a top-level `capabilities` array (for example `{ "context": { "version": 1, ..., "capabilities": ["stream"] } }`); see [Streamed suggestions](#streamed-suggestions). A context whose `version` the server does not implement is rejected with `{ "error": "unsupported_context_version" }`. |
| Audio | `{ "source": "mic"|"system", "chunk": "<base64>" }` | Chunk is mono, signed 16-bit little-endian PCM at 48 kHz. `chunk` may also be a byte array for non-browser clients. Decoded chunks are capped at 64 KiB (larger ones receive `{ "error": "Audio chunk too large" }`); WebSocket messages are capped at 128 KiB. |
| Typed interviewer question | `{ "interviewer_question": "..." }` | Fallback when interviewer (system) audio is unavailable, e.g. Linux microphone-only mode. The text is trimmed and must be 1–2,000 characters, otherwise the frame is answered with `{ "error": "Invalid message" }`. The server treats it exactly like a final interviewer utterance: it is stored in history, echoed back as a `caller` transcript, and, if it is classified as a question, scheduled for generation (latest question wins). Ignored after `end`. |
| Response action | `{ "action": { "type": "regenerate"|"shorten"|"expand"|"clarify", "generationId": "g7" } }` | Asks for a new generation from the current suggestion. `generationId` must be the ID of the latest generation for the current interviewer question (1–64 characters); no other fields are allowed. A malformed frame (unknown type, missing or oversized ID, extra fields) receives `{ "error": "Invalid message" }`; a well-formed one that cannot run receives `{ "error": "action_rejected", "reason": "..." }`. Ignored after `end`. See [Response actions](#response-actions). |
| End | `{ "end": true }` | Stops the active transcription streams and any in-flight generation; later utterances and late replies are suppressed. For a resume-capable session it also purges the session immediately (no resume window). |
| End with debrief | `{ "end": { "debrief": true } }` | Debrief-capable clients only (see [Unsaved debrief](#unsaved-debrief)). Stops capture and model work like `{ "end": true }`, then generates one review of the interview, sends `{ "debrief": ... }`, and purges. The `end` object may contain only a boolean `debrief`; anything else (for example `{ "end": { "debrief": "yes" } }`) receives `{ "error": "Invalid message" }` and does not end the session. Without the `debrief` capability, or with `debrief: false`, it is a plain end. |

The desktop client stops a session in this order: ask each audio worklet to flush its partial batch, wait (at most 250 ms) for that final audio chunk and send it, send `{ "end": true }`, then close the socket. **Stop and review** sends `{ "end": { "debrief": true } }` instead and closes the socket only after the `debrief` message arrives (or after 45 s).

## Server messages

| Message | Shape | Meaning |
| --- | --- | --- |
| Transcript | `{ "speaker": "you"|"caller", "transcript": "..." }` | A final Deepgram utterance, or the echo of a typed interviewer question (`caller`). These are legacy wire labels: `mic`/`you` is shown as **Candidate** and `system`/`caller` as **Interviewer** in the desktop UI. A near-exact repeat of the same source's previous final utterance within 3 s is dropped (see [Utterance deduplication](#utterance-deduplication)); typed questions are never dropped. |
| Interim transcript | `{ "interim": { "speaker": "you"|"caller", "text": "..." } }` | Interim-capable clients only. The in-progress speech of one source, replacing that speaker's previous interim line; `text: ""` clears it. Display-only: never stored, classified, or replayed. See [Interim transcripts](#interim-transcripts). |
| Generation thinking | `{ "generation": { "state": "thinking" } }` (streaming clients: `{ "generation": { "id": "...", "state": "thinking" } }`) | Sent when a generation for the latest interviewer question starts (after the budget check, before the model call). Clients should hide the previous suggestion so stale guidance is not shown as the answer to the new question. A newer question aborts the in-flight generation; the superseded one sends nothing further, and the newer one sends its own `thinking`. |
| Generation streaming | `{ "generation": { "id": "...", "state": "streaming" }, "delta": "..." }` | Streaming clients only. The next piece of the current generation's suggestion text; append it to the text received so far for that ID. See [Streamed suggestions](#streamed-suggestions). |
| Generation failed | `{ "generation": { "state": "failed" }, "ai_reply": "[Erreur du modèle]" }` (streaming clients: `generation` also carries `id`) | Terminal for the current question: the model returned no text, timed out, or the pipeline failed. Transcription keeps running. `ai_reply` is retained only for older clients; clients that understand `generation` must prefer the failure state over the reply text. Not sent for superseded generations. |
| Suggestion | `{ "ai_reply": "...", "model"?: { "selected": "...", "actual": "..."|null } }` (streaming clients, for live generations: plus `"generation": { "id": "...", "state": "done" }`) | Introductory or response suggestion. The additive `model` object reports the model the server requested (`selected`) and the model the provider says served it (`actual`, `null` when the provider omits it). It is present when the provider reported model information; older clients can ignore it. The desktop client shows it under the suggestion as `Model: <actual or selected>`, naming both when they differ. |
| Budget reached | `{ "error": "interview_budget_reached" }` | The interview's reported model cost reached `MAX_INTERVIEW_COST_USD`. Sent instead of generating, either for the introductory suggestion or for an interviewer question. Transcription continues; no further suggestions are generated for this interview. |
| Action rejected | `{ "error": "action_rejected", "reason": "stale_generation"|"no_final_answer"|"rate_limited"|"question_limit_reached"|"disconnected" }` | Answer to a response action that did not run; no model call was made. See [Response actions](#response-actions). |
| Unsupported context version | `{ "error": "unsupported_context_version" }` | The context declares a `version` other than `1` (legacy contexts omit `version`). The context is rejected: nothing is stored, no introductory suggestion is generated, and the previous session context, if any, stays in effect. |
| Unsupported model | `{ "error": "unsupported_model" }` | The context's `settings.model` is not in the server allowlist. The context is rejected (no introductory suggestion) and the previous session context, if any, stays in effect. The desktop client tells the candidate to pick another model in Interview Settings. |
| Other errors | `{ "error": "..." }` | `Invalid message` (including a context with a malformed `capabilities` list), `Unsupported audio chunk type`, or `Audio chunk too large`. The socket remains open. |
| Session | `{ "session": { "id": "..." } }` | Resume-capable clients only. Sent once, right after the first context that lists `"resume"` is accepted (before its introductory suggestion). The ID is opaque. |
| Resumed | `{ "resumed": { "sessionId": "...", "seq": 42, "truncated"?: true } }` | Answer to a successful `resume`, sent after the replayed messages. `seq` is the latest sequence number the session has assigned. `truncated: true` means some committed messages after `lastSeq` were evicted from the replay buffer. |
| Notice | `{ "notice": "audio_gap" }` | Sent after `resumed`: audio captured while the client was disconnected never reached the server and was not transcribed. |
| Resume failed | `{ "error": "resume_expired" }` or `{ "error": "resume_rejected" }` | Answer to a `resume` that cannot be honoured. The socket stays open as a new connection; send a context to start a new session. |
| Debrief | `{ "debrief": { "status": "ready", "review": { ... } } }` or `{ "debrief": { "status": "failed"|"skipped", "reason": "..." } }` | Answer to `{ "end": { "debrief": true } }`, sent once, before the session is purged. Never sent after the socket closed. See [Unsaved debrief](#unsaved-debrief). In a resume-capable session it carries a `seq` but is not replayed. |

Audio messages are JSON, not binary WebSocket frames. The server parses every frame as JSON and accepts only `mic` and `system` source labels. Invalid or malformed messages receive `{ "error": "Invalid message" }` while the socket remains available. Send context before audio so suggestions include it, and send `end` before an intentional shutdown.

## Streamed suggestions

Streaming is opt-in. A client advertises it by listing `"stream"` in the top-level `capabilities` array of its context message. `capabilities` must be an array of at most 8 strings of 1–32 characters; otherwise the whole context frame is rejected with `{ "error": "Invalid message" }` and nothing is stored. Unknown capability names are ignored. Capabilities describe the client, not the interview: they are not stored with the session context and never reach a model.

The most recently accepted context decides. Sending a context without `"stream"` downgrades the session to the legacy messages. Each generation keeps the setting it started with, so a change applies from the next generation.

For a streaming client, each live (interviewer-question or response-action) generation has an opaque string `id`, unique within the session. Clients must only compare it for equality. Every `generation` object that carries an `id` also carries an additive `kind`: `"answer"` for an interviewer question, or the response action that started it (`"regenerate"`, `"shorten"`, `"expand"`, `"clarify"`). Clients should ignore kinds they do not know. A generation produces, in order:

1. `{ "generation": { "id": "g7", "kind": "answer", "state": "thinking" } }` — exactly once, before the model call.
2. Zero or more `{ "generation": { "id": "g7", "kind": "answer", "state": "streaming" }, "delta": "..." }`. Deltas are raw candidate-facing text (whitespace included). They are coalesced on the server and sent at most every ~50 ms. Reasoning or other non-text model output is never streamed.
3. Exactly one terminal message:
   - `{ "ai_reply": "...", "model"?: {...}, "generation": { "id": "g7", "kind": "answer", "state": "done" } }`. `ai_reply` is the complete, trimmed suggestion and **replaces** the streamed text. Any pending delta is sent before it.
   - or `{ "generation": { "id": "g7", "kind": "answer", "state": "failed" }, "ai_reply": "[Erreur du modèle]" }`. Discard any streamed text for that ID. A reply that is empty after trimming is a failure, never `done`.

Ordering guarantees:

- Messages for one generation arrive in the order above, and nothing for that ID follows its terminal message.
- A generation superseded by a newer interviewer question (latest question wins), stopped by `end`, or ended by socket close sends nothing further: no delta, no terminal message. (Exception: in a resume-capable session, a generation interrupted by a disconnect sends one `failed` message with `reason: "disconnected"`, delivered by the resume replay; see [Resumable sessions](#resumable-sessions).) The newer generation then sends its own `thinking` with a new `id`. Clients should ignore any `streaming`, `done`, or `failed` message whose `id` is not the current generation's. For example, a client that submits a typed question can ignore deltas for the previous ID until the new `thinking` arrives.
- Transcript messages may arrive between generation messages.
- When the provider cannot stream (Groq rollback mode), a streaming client receives `thinking`, then the terminal message, with no deltas.

Not streamed: the introductory suggestion sent after a context, and `interview_budget_reached` errors. Both keep their existing shape, with no `generation` object.

Compatibility: clients that do not advertise `"stream"` (or `"actions"`, below) receive exactly the legacy messages (`{ "generation": { "state": "thinking" } }`, `{ "ai_reply": ... }`, and the failure shape, with no `id`, no `kind`, and no deltas). Servers older than this feature ignore the unknown `capabilities` key and send the legacy messages, which streaming clients must continue to handle.

## Interim transcripts

Interim lines are opt-in, like streaming. A client advertises them by listing `"interim"` in the context `capabilities` (the desktop client sends `["stream", "resume", "debrief", "interim"]`). The most recently accepted context decides: a context without `"interim"` stops them, and any pending line is dropped.

While a source (`mic` → `you`, `system` → `caller`) is speaking, the server sends `{ "interim": { "speaker": "caller", "text": "Tell me about a time" } }`. `text` is the utterance so far: its finalized segments plus Deepgram's current hypothesis, trimmed. It is bounded to 500 characters (the newest part is kept).

- **Replace, don't append.** Each interim frame replaces that speaker's previous interim line. A client holds at most one interim line per speaker.
- **Final wins.** The speaker's final `{ "speaker", "transcript" }` message ends the line; the client replaces the interim line with the final transcript. A pending interim update is dropped when the final arrives, so no interim frame for an utterance follows its final.
- **Clear.** `text: ""` clears the speaker's line without a final transcript: speech that produced no final text, or a final that was dropped as a duplicate.
- **Throttled.** At most one interim frame per source every 200 ms (≤ 5/s); between frames only the newest text is kept, and unchanged text is not resent.
- **Display-only.** Interim text is never stored in chat history, never classified, never starts a generation, and never reaches a model. Only final utterances do.
- **Not committed.** In a resume-capable session interim frames carry a `seq` like every message but are never replayed after a resume. Clients should clear interim lines when the connection drops.
- **Stops.** No interim frames are sent after `end`, after the socket closes, or while a resume-capable session is disconnected (its streams are stopped). The desktop client also clears its interim lines on pause and ignores interim frames while paused.

Example:

```json
{ "interim": { "speaker": "caller", "text": "Tell me" } }
{ "interim": { "speaker": "caller", "text": "Tell me about a time you led a migration." } }
{ "speaker": "caller", "transcript": "Tell me about a time you led a migration." }
```

Compatibility: clients that do not advertise `"interim"` never receive `interim` frames. Servers older than this feature ignore the capability and send only final transcripts.

## Utterance deduplication

Deepgram can deliver the same final speech twice around an utterance boundary. The server drops a final utterance (it is not stored, sent, or classified, so it cannot start a second generation) when, within 3 s of the same source's previous final utterance, its normalized text (case, punctuation, and whitespace ignored) is identical to it, or repeats its last words (at least three). A repeat extends the window. Shorter follow-ups such as "Why?" and typed interviewer questions are never dropped. If an interim line was shown for a dropped utterance, an interim-capable client receives `{ "interim": { "speaker": ..., "text": "" } }` instead of a transcript.

## Response actions

A candidate can ask for a different take on the current suggestion with `{ "action": { "type": ..., "generationId": ... } }`:

| `type` | Result |
| --- | --- |
| `regenerate` | A fresh answer to the same interviewer question, from the same selected evidence. |
| `shorten` | The latest final answer for the question rewritten as at most three speakable sentences, adding nothing new. |
| `expand` | The latest final answer for the question expanded into evidence-grounded STAR detail (Situation, Task, Action, Result). Missing evidence is stated, not invented. |
| `clarify` | One to three short clarifying questions the candidate could ask the interviewer, each with what it would disambiguate. It does not answer the question, and it does not replace the answer that later `shorten`/`expand` actions use. |

An action targets a generation ID, so a client needs IDs: streaming clients have them; a non-streaming client advertises `"actions"` in the context `capabilities` to receive `id` and `kind` on its `thinking`, final `ai_reply`, and `failed` messages (still without deltas). Without either capability the generation messages keep their legacy shapes.

An accepted action runs through the latest-question-wins scheduler as a **new generation** with a new `id` and the action's `kind`. It supersedes (aborts) any generation in flight, which then sends nothing further; a newer interviewer question supersedes an action in flight the same way. Streaming clients receive the usual `thinking` → `streaming`* → `done`/`failed` sequence; non-streaming clients receive `thinking` and the final `ai_reply` (or failure). Example, after `g7` completed:

```json
{ "action": { "type": "shorten", "generationId": "g7" } }
{ "generation": { "id": "g8", "kind": "shorten", "state": "thinking" } }
{ "generation": { "id": "g8", "kind": "shorten", "state": "streaming" }, "delta": "I led the billing migration " }
{ "ai_reply": "I led the billing migration with zero data loss.", "generation": { "id": "g8", "kind": "shorten", "state": "done" } }
```

Action outputs are not added to the conversation history sent with later questions; the interviewer question and the previous answer reach the model only as quoted data, never as instructions.

An action that cannot run is answered with `{ "error": "action_rejected", "reason": ... }` and makes no model call:

| `reason` | When |
| --- | --- |
| `stale_generation` | `generationId` is not the latest generation of the current interviewer question (an older generation, an unknown ID, or a newer question has arrived). |
| `no_final_answer` | `shorten` or `expand` before the question has a completed answer (for example while it is still generating, or after it failed). `regenerate` and `clarify` do not need one. |
| `rate_limited` | Less than 1.5 s since the previous accepted action. |
| `question_limit_reached` | Five actions were already accepted for this interviewer question. The count resets with the next question. |
| `disconnected` | Resume-capable sessions only: the action was still queued (not started) when the socket dropped. It is never run later. |

Actions are charged to the interview budget like any generation. When the budget is spent, an action is answered with `{ "error": "interview_budget_reached" }` instead.

## Unsaved debrief

At the end of an interview the candidate can ask for a review of it. It is opt-in twice: the client lists `"debrief"` in the context `capabilities` (the desktop client sends `["stream", "resume", "debrief", "interim"]`), and it ends with `{ "end": { "debrief": true } }`. Like other capabilities, the most recently accepted context decides. `{ "end": true }` is unchanged for every client.

On a debrief end the server:

1. stops the transcription streams and any generation, exactly like `{ "end": true }`;
2. unless the interview budget is spent or nothing was said, runs **one** model generation over the session's stored transcript (interviewer and candidate lines as spoken; the AI suggestions shown during the interview are passed separately, labelled as suggestions, never as things the candidate said), with at most one repair attempt when the output does not match the schema;
3. sends `{ "debrief": ... }`;
4. purges the session as it does today (a resume-capable session is purged immediately; an ordinary session when its socket closes).

If the socket closes while the debrief is being prepared, the model request is aborted, nothing is sent, and the session is purged (a resume-capable session gets no resume window). Further `end` frames during the preparation are ignored.

A ready debrief:

```json
{
  "debrief": {
    "status": "ready",
    "review": {
      "questionsCovered": [
        { "question": "Tell me about a migration you led.", "candidateAnswerSummary": "You described moving billing to PostgreSQL.", "evidenceUsed": ["evidence-1"] }
      ],
      "strengths": ["You named a concrete system."],
      "improvementTopics": [
        { "topic": "Close with the result", "why": "The zero-data-loss outcome was not mentioned.", "practiceSuggestion": "End each story with one measurable result." }
      ],
      "followUpDraft": "Thank you for the conversation about the role."
    }
  }
}
```

| Field | Bounds |
| --- | --- |
| `questionsCovered` | At most 12; `question` ≤ 300 characters, `candidateAnswerSummary` ≤ 600, `evidenceUsed` ≤ 3 IDs. |
| `evidenceUsed` | IDs of the context's `evidence` entries: `evidence-N` is the N-th entry (1-based). Unknown IDs are removed. Legacy contexts have none. |
| `strengths` | At most 5, each ≤ 300 characters. |
| `improvementTopics` | At most 5; `topic` ≤ 120, `why` ≤ 400, `practiceSuggestion` ≤ 400 characters. |
| `followUpDraft` | ≤ 2,000 characters; may be empty. A draft for the candidate to edit and send themselves; the server never sends it anywhere. |

Over-long values are clipped. No other field is ever present: the review contains no score, ranking, or hiring prediction. All values are untrusted model output and must be rendered as plain text.

| `status` / `reason` | When |
| --- | --- |
| `skipped` / `budget_reached` | The interview budget was already spent; no model call was made. |
| `skipped` / `empty_transcript` | No interviewer or candidate line was transcribed; no model call was made. |
| `failed` / `invalid_output` | The output did not match the schema after the repair attempt (or the budget ran out before it). |
| `failed` / `timeout` | The debrief took longer than 30 s in total. |
| `failed` / `generation_failed` | The provider request failed. |

Cost: each model request is charged to the interview budget like any other, with an output cap of 1,500 tokens; at most two requests (generation and repair) per debrief.

Privacy: the review is not stored. It exists only in the `debrief` message; the transcript, context, and budget are purged right after. Saving reviews is not implemented.

Compatibility: servers older than this feature ignore the `debrief` capability and treat `{ "end": { "debrief": true } }` as a plain end without answering, so a client must time out its wait (the desktop client waits 45 s, then reports that no review arrived).

## Resumable sessions

Resume is opt-in, like streaming. A client advertises it by listing `"resume"` in the context's `capabilities` array (the desktop client sends `["stream", "resume", "debrief", "interim"]`). Once a session has accepted such a context, resume stays on for that session's lifetime, even if a later context omits `"resume"`, because the client depends on the sequence numbers. Clients that never send `"resume"` get exactly the behavior described above: no `seq`, no `session` message, and the session is purged as soon as the socket closes.

### Session identity and ownership

- Session IDs are 128 random bits encoded as 22 base64url characters. They are opaque: compare them only for equality. Redis keys keep their names (`chat:<id>`, `context:<id>`).
- A session is bound to the authenticated owner that created it: the `app_id` and `device_id` claims of the connection's JWT. A resume with a valid token for another device answers `{ "error": "resume_rejected" }`. The target session is not changed, nothing is replayed, and the socket stays open so the client can start a new session on it. The server does not close the socket, so a client can treat `resume_rejected` exactly like `resume_expired`.

### States

`active` → (socket closes) → `disconnected` → (resume) → `active`, or → (resume window elapses) → `expired`. `{ "end": true }` moves an active session to `ended`; `{ "end": { "debrief": true } }` does so after the debrief is sent, and a socket close while it is prepared ends (and purges) the session instead of disconnecting it. Ended and expired sessions are purged (chat history, context, and budget, as before) and can no longer be resumed.

When the socket of a resume-capable session closes without `end`, the server:

- keeps the context, history, model choice, and budget;
- stops the Deepgram streams (they reopen on the next audio chunk after a resume);
- aborts the in-flight introductory suggestion (it is never sent) and the in-flight live generation, drops any queued question, and never re-runs them, so a resume never causes a duplicate paid model request. An interrupted live generation (including one started by a response action) is reported, through the replay buffer, as `{ "generation": { "id"?: "...", "kind"?: "...", "state": "failed", "reason": "disconnected" }, "ai_reply": "[Erreur du modèle]" }`; `id` and `kind` are present for streaming clients, as in the normal failure shape. A response action still queued is reported as `{ "error": "action_rejected", "reason": "disconnected" }`. Neither is re-run;
- starts the resume window, `RESUME_WINDOW_MS` (default 120,000 ms). When it elapses the session is purged.

If a `resume` arrives for a session that is still attached to another open socket (for example a half-open connection the server has not detected yet), the newer connection takes the session over and the older socket is closed with code `4002` and reason `session_resumed_elsewhere`. Frames from the old socket are ignored after that.

### Sequence numbers and replay

For a resume-capable session, every server message produced by the session carries an additive integer `seq` that starts at 1 and increases by one per message, including `thinking` and streamed deltas. Session-control frames (`session`, `resumed`, `notice`, and `resume_*` errors) carry no `seq`.

The server keeps a replay buffer of **committed** messages only: transcripts, final and failed suggestions (anything with `ai_reply`), and errors. `thinking`, streaming deltas, and `interim` frames are never replayed, so a client sees gaps in `seq` after a resume; that is expected. The buffer holds at most the last 200 messages and 256 KiB per session. If messages after `lastSeq` were evicted, `resumed.truncated` is `true`.

### Resume handshake

1. The client opens a new authenticated connection and sends `{ "resume": { "sessionId": "...", "lastSeq": N } }` as its first frame.
2. If the session exists, is resumable, belongs to the same owner, and has not ended or expired, the server rebinds it to the new socket, sends every retained committed message with `seq > N` in order, then `{ "resumed": { "sessionId": "...", "seq": M } }`, then `{ "notice": "audio_gap" }`. The session continues with `seq` values after `M`. The client must not resend its context: the stored one stays in effect.
3. Otherwise the server answers `{ "error": "resume_expired" }` (unknown, ended, expired, or never-resumable session) or `{ "error": "resume_rejected" }` (another owner). The client then sends its context on the same socket and receives a new `session` ID; its `seq` restarts at 1.

Clients must de-duplicate by `seq`: ignore any sequenced message whose `seq` is not greater than the highest one already applied for the current session ID.

### Guarantees and limits

- No duplicate paid requests: a generation interrupted by a disconnect is reported failed and never re-run. The candidate can ask again.
- Response actions are sequenced like every other message: `action_rejected` errors and an action's final or failed suggestion are replayed, its `thinking` and deltas are not. A suggestion completed before the disconnect can still be the target of an action after a resume.
- Audio sent while disconnected is lost. The server does not fabricate or interpolate it and reports it with `audio_gap`. The desktop client drops audio while reconnecting; it never queues audio for a later socket.
- Session state and the replay buffer are kept in the memory of one backend process. A resume must reach the same instance, and a server restart loses every resumable session (clients then get `resume_expired`). A multi-instance deployment needs a shared replay store (for example Redis) and sticky routing first.
- This is the `/ws` protocol. The planned `/ws/v2` envelope (event IDs, acknowledgements, per-source audio sequence numbers) is not implemented yet.

### Desktop client behavior

After the server has named a session, an unexpected close (anything other than the candidate pressing Stop) shows **Reconnecting…** and retries with jittered exponential backoff: each delay is between half and all of 0.5 s, 1 s, 2 s, 4 s, then 8 s (the cap), for at most 120 s in total. Each attempt asks the main process for a fresh WebSocket URL and sends `resume` first. On `resume_expired` or `resume_rejected` it starts a new session with the stored context and shows "Reconnected — new session started". When the window runs out it shows **Connection lost** with a **Start new session** button. Stop cancels any pending reconnect. A client that never received a `session` message (an older server) does not reconnect and shows **Disconnected**, as before.
