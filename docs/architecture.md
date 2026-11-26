# Architecture

```text
React renderer ── IPC ──> Electron main ── HTTPS ──> Express auth API
      │                         │
      └─ PCM audio over WSS ────┴──────────────────> WebSocket server
                                                       │
                                  ┌────────────────────┼───────────────────┐
                                  ▼                    ▼                   ▼
                              Deepgram              Redis        LangGraph → OpenRouter
                           transcription      context/history/budget   (or legacy Groq)
```

## Request and audio flow

1. Electron creates a persisted random installation ID and posts it with the application ID to `/auth/token`.
2. Express validates the app ID, issues a JWT, and Electron keeps it in the main process. The renderer requests only a signed WSS URL through the narrowly exposed preload API.
3. The conversation page opens the socket, sends caller/context data, captures both inputs at 48 kHz, converts Float32 audio to mono PCM16, and sends base64 chunks labelled `mic` or `system`.
4. One Deepgram live stream is created per label. Completed utterances are saved to Redis and returned as transcripts.
5. A completed `system` (interviewer) utterance, or a typed interviewer question in microphone-only mode, goes through the question classifier; acknowledgements stop there. Interviewer utterances since the candidate last spoke form one turn (a new turn starts after the candidate speaks, after 20 s of interviewer silence, or with a typed question; at most 4 parts and 2,000 characters), so a question split across pauses is one multipart question for response actions, and the reply prompt asks for every part to be answered in order. Questions run the bounded LangGraph workflow (select up to three approved evidence references, then one generation call) against the session's allowlisted OpenRouter model (`AI_PROVIDER=openrouter`) or legacy Groq. A newer question aborts an in-flight generation (latest question wins), usage is charged against the per-interview budget, and the reply returns with the selected/actual model IDs.

## Boundaries

The Electron main process owns authentication, OS audio routing, auto-updates, and IPC. The renderer owns UI state, browser media capture, and WebSocket display. The backend owns credential validation, JWT verification, Deepgram and model-provider calls, the model catalog, Redis session data, budgets, and logs. Keep these responsibilities separate; never expose provider credentials or raw JWTs to React code.

## Session lifetime

A connection receives an in-memory base-36 session ID. Redis keys `chat:<sessionId>` (bounded to 40 turns) and `context:<sessionId>` expire after two hours and are deleted when the connection closes. The backend also closes Deepgram streams on an explicit `{ "end": true }` message or socket close.
