# Desktop Client

The desktop application lives in `Call_Listener_Frontend/v-0/`. It combines Electron, Vite, React, React Router, Tailwind, and Framer Motion.

## Main process and security

`main.js` creates the window and tray, performs authentication, selects platform capabilities, controls auto-updates, and delegates all audio lifecycle work to a platform-audio adapter (see below). It loads the renderer on a neutral `/connecting` screen before authenticating, then navigates to the result route. The token request (`AuthManager`) has a 10 s wall-clock timeout (`AUTH_REQUEST_TIMEOUT_MS`, injectable as `requestTimeoutMs`), and the model catalog request has its own 5 s deadline; a timeout rejects with `code: "ETIMEDOUT"`, which `services/authFailure.js` classifies as `server_unreachable` (or `offline` when `net.isOnline()` is false). `preload.js` exposes only the explicit `getWsUrl()`, `getPlatformCapabilities()`, `getModels()`, and `getDiagnostics()` methods. `getModels()` asks the main process to call the backend `GET /models` with its own `call_token`; the renderer receives only model IDs, names, and availability (or `null` on failure), never the token. The Interview Settings step shows the catalog as an "AI model" picker: unavailable models are listed but disabled, the server default is used when nothing is chosen or the catalog cannot be loaded, and a saved choice that is no longer offered is cleared with a visible notice rather than silently replaced. `services/security.js` restricts media permissions to the packaged page or local Vite origin, injects the development guard header, and sets a production content-security policy.

Do not enable Node integration or disable context isolation. Keep tokens in `AuthManager` in the main process. Production navigation opens external URLs through the system shell rather than inside the application.

## Renderer and routing

`src/App.jsx` uses `HashRouter`. The normal sequence is `/` (device setup), `/context` (legacy caller/user data, pending candidate/job migration), then `/conversation` (live audio). Supporting pages display connecting (before auth resolves), authentication, unsupported-OS, missing-VB-Cable, and diagnostics states. Shared page chrome and theme state are in `src/layout/` and `src/ui/UIContext.jsx`.

The conversation page captures two distinct `audioinput` devices when system capture is available. In Linux microphone-only mode it captures just the candidate microphone and clearly identifies interviewer audio as unavailable. `src/worklets/pcm-processor.js` is preferred; the page falls back to `ScriptProcessor` if worklets fail. Both paths emit PCM16, mono, 48 kHz chunks to the backend. UI device and legacy context selections are stored in localStorage.

`src/pages/Conversation.jsx` only composes and renders the live workspace. Its logic lives in tested modules:

- `src/services/conversationState.js` — pure reducer for status, transcript entries, the current (latest) interviewer question, pending/thinking guidance, streamed guidance keyed by generation ID (deltas append only for the current ID; the final reply replaces them; other IDs are ignored), stale-guidance hiding, terminal failure/budget states, pause, response-action state (the shown suggestion's `kind`, the completed generation an action may target, a pending action, and the last rejection), and dropped-audio counts. Incoming server messages pass through an ordered list of handlers. `canRequestResponseAction(state)` decides whether the response actions are available.
- `src/hooks/useInterviewSocket.js` — opens the socket from `window.callApi.getWsUrl()`, sends stored context on open (adding `capabilities: ["stream", "resume", "debrief"]`), routes every socket event to one `dispatch`, applies audio backpressure, sends typed questions and response actions, and ends idempotently (also on unmount). `endWithReview()` sends `{ end: { debrief: true } }`, stops reconnecting, and resolves with the `debrief` answer (or a failure when the socket closes or nothing arrives within 45 s) before closing the socket.
- `src/components/LiveGuidancePanel.jsx` — current question, plain-text suggestion (never HTML), the suggestion kind, response actions, relevant experience, and the typed-question fallback.
- `src/hooks/useAudioCapture.js` — getUserMedia, AudioWorklet (or `ScriptProcessor` fallback) graph, meter levels, flush, and idempotent release of tracks and the `AudioContext`.
- `src/services/audioCapture.js` and `src/services/interviewMessages.js` — pure capture helpers and client message encoders.
- `src/components/TranscriptLog.jsx` — text-only transcript with near-bottom auto-scroll.
- `src/services/debriefState.js`, `src/services/debriefMarkdown.js`, `src/components/DebriefPanel.jsx` — the unsaved review (below).

### Response actions

Under the suggested answer, four buttons ask the backend for a different take on the current suggestion ([protocol](protocols/websocket.md#response-actions)):

| Button | Shortcut | Result |
| --- | --- | --- |
| Regenerate | Alt+R | A fresh answer to the same question. |
| Shorter | Alt+S | The answer as at most three speakable sentences. |
| More detail | Alt+E | Evidence-grounded STAR detail. |
| Clarify | Alt+C | Clarifying questions to ask the interviewer. |

The buttons apply only to a completed suggestion for a live question (not the introductory suggestion). They are disabled while a suggestion is being generated or an action is pending, while paused, while disconnected or reconnecting, after a failure, and once the interview budget is reached. Shortcuts use the physical key (`event.code`), so they work on layouts where Alt+letter types a character, and they are ignored while focus is in a text field (for example the typed-question box) or when Ctrl, Shift, or Meta is held. A badge names the kind of the shown suggestion ("Shorter answer", "Clarifying questions to ask", …). A rejected action (for example rate limited or no longer current) is explained in plain text below the buttons; a stale rejection disables the buttons until the next answer. Buttons show a visible focus ring (`.btn:focus-visible`).

### Stop and review

The top bar has **Pause**, **Stop and review**, and **Stop** (ordinary buttons, reachable with Tab and activated with Enter or Space). **Stop** behaves exactly as before. **Stop and review** follows the same order (flush the final audio batch, send it, end, release capture) but sends `{ "end": { "debrief": true } }` and keeps the socket open until the backend answers ([protocol](protocols/websocket.md#unsaved-debrief)). The live view is replaced by the review panel, which shows "Preparing your review…" and then either:

- the review: questions covered (with what the candidate said and the evidence used, named by requirement), strengths, topics to improve, and an editable follow-up draft (a textarea; it is never sent anywhere), or
- a plain-text explanation when the review was skipped (budget spent, nothing transcribed) or failed (including no answer within 45 s or a closed connection).

Everything is rendered as text nodes, never HTML. `debriefState.js` is the pure reducer (`idle` → `preparing` → `ready`/`failed`/`skipped`; edits to the draft; discard) and bounds what the server sent.

**Export as Markdown** builds the file in the renderer with the pure `buildDebriefMarkdown()` (all review text backslash-escaped so it stays literal Markdown; the draft goes in a fenced block) and saves it through a `Blob` and a temporary `<a download>` link, so Electron shows its save dialog. No IPC is involved. **Discard** (or **Cancel** while preparing, **Back to setup** after a failure) forgets the review and returns to setup.

Nothing is stored: the review lives only in page state, never in localStorage or the main process, and the backend purges the session right after sending it. The panel says so, and the exported file is the only copy.

## Platform audio adapter

`services/platformAudio/index.js` exports `createPlatformAudio({ platform, capabilities, logger, fs, windows })`, which picks an adapter from `services/platformCapabilities.js` output. `main.js` no longer branches on `process.platform` for audio; startup, the tray, `powerMonitor` suspend/resume, quit cleanup, and the diagnostics IPC all go through the adapter:

| Adapter | Chosen when | Behavior |
| --- | --- | --- |
| `windows-vb-cable` (`windowsAdapter.js`) | capability strategy `vb-cable` | Wraps `AudioRouteManager` unchanged. `prepare()` resolves SoundVolumeView through the injected `ensureTools` UI hook; `ensureReady()` recovers a dirty state, detects VB-Cable, enables routing, and sets the cable as default, or returns `needs-device` (main shows `/novbcable`, offers the installer, and polls). Redundant enable/disable calls are skipped, routing changes are serialized, `gracefulExit()` runs once, and routing is never re-enabled after exit. |
| `linux-app-streams` (`linuxAdapter.js`) | Linux | Runs no commands and never changes OS routing. Stops only streams registered with `trackStream(id, { stop })`. Reports microphone-only capture until PipeWire desktop capture (L2) is qualified. No tray is created because there is no routing to toggle. |
| `unsupported` | any other OS | Inert; main shows `/unsupported`. |

`describe()` returns a renderer-safe snapshot (kind, state, routing flag, error code). It never includes paths, device IDs, or raw error messages.

## Diagnostics screen

`/diagnostics` (activity icon in the header, available on every screen including Connecting) shows OS family and architecture, display server (X11/Wayland from `XDG_SESSION_TYPE`, `WAYLAND_DISPLAY`, or `DISPLAY`; `n/a` outside Linux), capture strategy, interviewer-audio availability, adapter kind and state, routing state (Windows), app and Electron versions, and actionable issues. The main process builds it with the pure `services/diagnostics.js` `buildDiagnostics()`, which whitelists fields, accepts only short version/enum tokens, and maps error codes to fixed copy. It must never carry hostnames, user names, installation IDs, user paths, or IP addresses; `test/diagnosticsBuilder.test.js` enforces this.

## Windows audio routing

`AudioRouteManager` uses bundled SoundVolumeView to detect VB-Cable, save the prior playback device, enable “listen to this device,” and restore settings on a clean exit. It writes recovery state to Electron user data and starts `watchdog.js` so a crashed app also restores the device. VB-Cable installation requires elevation. Test routing carefully: it changes the Windows default playback device.

## Linux baseline

Linux is an unqualified, microphone-only development path. It must not invoke VB-Cable installation, SoundVolumeView, audio routing, or the Windows watchdog; the `linux-app-streams` adapter guarantees this structurally. PipeWire desktop audio, monitor-source fallback, packaging, and real Electron startup validation remain tracked in the [Linux support plan](plan/08-linux-support.md).
