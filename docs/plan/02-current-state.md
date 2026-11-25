# Current Implementation and Migration Risks

This is a source inspection, not a claim that the application or Windows installer has been tested. Paths below are relative to the repository root.

## Existing building blocks

The backend is Node/Express plus a separate WebSocket server, Redis, Deepgram `nova-3`, and a direct Groq call. The desktop is Electron with a React/Vite renderer, two audio inputs, PCM conversion, SoundVolumeView routing, and a recovery watchdog. Keep these boundaries during the migration.

The backend uses ES modules; Electron main/preload/services currently use CommonJS. Preserve each runtime's module format instead of changing the desktop package to ESM as a side effect of adding LangChain on the backend.

## Findings to address

| Finding and source | Consequence | Planned treatment |
| --- | --- | --- |
| `server/services/ai/groqService.js` fixes the provider and model; `promptBuilder.js` is generic and French-only | No model selection or interview grounding | Provider adapter in Phase 2; candidate prompts in Phases 3–4 |
| `server/services/transcription/streamManager.js` skips replies while busy/cooling down | An interviewer follow-up can go unanswered | Bounded scheduling, turn IDs, and cancellation in Phases 1 and 4 |
| Its timeout uses `Promise.race` without aborting the provider request | Work can continue after timeout or session end | Propagated abort signals and late-result rejection |
| `DeepgramService.start()` does not wait for Open; lazy creation is asynchronous | Startup audio and concurrent stream creation need regression coverage | One initialization promise per source and bounded startup buffering |
| `connectionHandler.js` creates time-derived IDs and deletes history/context on any socket close | Network loss becomes interview loss | Owned stable sessions, explicit end, resume grace period, and TTL cleanup |
| `ChatHistory`/`ContextStore` have no TTL or bounded prompt history | Crash leftovers and increasing context size | TTLs, size limits, bounded turns, and evidence-preserving summaries |
| `Conversation.jsx` constructs model HTML and uses `dangerouslySetInnerHTML` | Generated content is rendered as markup | Plain text or restricted Markdown renderer before new streamed UI |
| `services/auth.js` returns a WSS URL containing the JWT to the renderer | Existing docs overstate token isolation | Short-lived, single-use socket tickets; redact URLs and tokens |
| `/auth/token` accepts a public app ID and caller-supplied device ID | This is not account authentication or trustworthy ownership | Enrolled installation credentials for pilot; identity design before shared history |
| `pcm-processor.js` sends every audio render block; renderer base64-encodes each | High message overhead; no explicit backpressure | Measure, then batch and bound queues in Phase 6 |
| Renderer socket close only updates the status text | No reconnect/resume workflow | Versioned resume contract and bounded reconnect policy |
| `services/audio.js` changes Windows defaults; disable removes restoration state | Suspend, toggle, crash, and quit paths need physical-device verification | Snapshot once; test idempotent restoration before audio changes |
| Deepgram logs full utterances at info level; files rotate for 14 days | Sensitive interview content enters operational logs | Metadata-only defaults and explicit diagnostic opt-in |
| `.dockerignore` excludes `.env`, but not every `.env.*` | `.env.docker` can enter a build context copied by the Dockerfile | Exclude secret files and verify image contents in Phase 1 |
| Backend unit/integration/framework tests and frontend Vitest tests exist, but coverage remains narrow | A partial regression baseline; no audio/WebSocket/provider fixture coverage yet | Expand fixtures and packaged Windows checks in Phase 0 |

## Documentation corrections to include with implementation

The current signed URL exposes the bearer token. Socket close cleanup is best-effort, not a retention guarantee. `/health` reports the Redis client's status but always labels the service `ok`; it is not a dependency-aware readiness check. Watchdog recovery is intended behavior and needs testing. Record verified behavior separately from intended behavior.

Do not hand-edit `dist/` or bundled `bin/` assets. Preserve app identifiers and existing user-data paths until an explicit migration is designed; the packaging and runtime IDs currently differ.
