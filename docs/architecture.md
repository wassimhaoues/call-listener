# Architecture

```text
React renderer ── IPC ──> Electron main ── HTTPS ──> Express auth API
      │                         │
      └─ PCM audio over WSS ────┴──────────────────> WebSocket server
                                                       │
                                  ┌────────────────────┼───────────────────┐
                                  ▼                    ▼                   ▼
                              Deepgram              Redis                Groq
                           transcription      session context/history   reply
```

## Request and audio flow

1. Electron creates a hostname-derived device ID and posts it with the application ID to `/auth/token`.
2. Express validates the app ID, issues a JWT, and Electron keeps it in the main process. The renderer requests only a signed WSS URL through the narrowly exposed preload API.
3. The conversation page opens the socket, sends caller/context data, captures both inputs at 48 kHz, converts Float32 audio to mono PCM16, and sends base64 chunks labelled `mic` or `system`.
4. One Deepgram live stream is created per label. Completed utterances are saved to Redis and returned as transcripts.
5. A completed `system` utterance triggers Groq. The backend combines context and chat history into a French prompt, stores the reply, and returns it to the client.

## Boundaries

The Electron main process owns authentication, OS audio routing, auto-updates, and IPC. The renderer owns UI state, browser media capture, and WebSocket display. The backend owns credential validation, JWT verification, Deepgram/Groq calls, Redis session data, and logs. Keep these responsibilities separate; never expose provider credentials or raw JWTs to React code.

## Session lifetime

A connection receives an in-memory base-36 session ID. Redis keys `chat:<sessionId>` and `context:<sessionId>` exist only for that connection and are deleted when it closes. The backend also closes Deepgram streams on an explicit `{ "end": true }` message or socket close.
