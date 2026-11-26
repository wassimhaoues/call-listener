# Desktop Client

The desktop application lives in `Call_Listener_Frontend/v-0/`. It combines Electron, Vite, React, React Router, Tailwind, and Framer Motion.

## Main process and security

`main.js` creates the window and tray, performs authentication, selects platform capabilities, controls auto-updates, and delegates all audio lifecycle work to a platform-audio adapter (see below). It loads the renderer on a neutral `/connecting` screen before authenticating, then navigates to the result route. The token request (`AuthManager`) has a 10 s wall-clock timeout (`AUTH_REQUEST_TIMEOUT_MS`, injectable as `requestTimeoutMs`), and the model catalog request has its own 5 s deadline; a timeout rejects with `code: "ETIMEDOUT"`, which `services/authFailure.js` classifies as `server_unreachable` (or `offline` when `net.isOnline()` is false). `preload.js` exposes only the explicit `getWsUrl()`, `getPlatformCapabilities()`, `getModels()`, and `getDiagnostics()` methods. `getModels()` asks the main process to call the backend `GET /models` with its own `call_token`; the renderer receives only model IDs, names, and availability (or `null` on failure), never the token. The Interview Settings step shows the catalog as an "AI model" picker: unavailable models are listed but disabled, the server default is used when nothing is chosen or the catalog cannot be loaded, and a saved choice that is no longer offered is cleared with a visible notice rather than silently replaced. `services/security.js` restricts media permissions to the packaged page or local Vite origin, injects the development guard header, and sets a production content-security policy.

Do not enable Node integration or disable context isolation. Keep tokens in `AuthManager` in the main process. Production navigation opens external URLs through the system shell rather than inside the application.

## Renderer and routing

`src/App.jsx` uses `HashRouter`. The normal sequence is `/` (device setup), `/context` (legacy caller/user data, pending candidate/job migration), then `/conversation` (live audio). Supporting pages display connecting (before auth resolves), authentication, unsupported-OS, missing-VB-Cable, and diagnostics states. Shared page chrome and theme state are in `src/layout/` and `src/ui/UIContext.jsx`.

The conversation page captures two distinct `audioinput` devices when system capture is available. In Linux microphone-only mode it captures just the candidate microphone and clearly identifies interviewer audio as unavailable. `src/worklets/pcm-processor.js` is preferred; the page falls back to `ScriptProcessor` if worklets fail. Both paths emit PCM16, mono, 48 kHz chunks to the backend. UI device and legacy context selections are stored in localStorage.

`src/pages/Conversation.jsx` only composes and renders the live workspace. Its logic lives in tested modules:

- `src/services/conversationState.js` — pure reducer for status, transcript entries, the current (latest) interviewer question, pending/thinking guidance, stale-guidance hiding, terminal failure/budget states, pause, and dropped-audio counts. Incoming server messages pass through an ordered list of handlers.
- `src/hooks/useInterviewSocket.js` — opens the socket from `window.callApi.getWsUrl()`, sends stored context on open, routes every socket event to one `dispatch`, applies audio backpressure, sends typed questions, and ends idempotently (also on unmount).
- `src/hooks/useAudioCapture.js` — getUserMedia, AudioWorklet (or `ScriptProcessor` fallback) graph, meter levels, flush, and idempotent release of tracks and the `AudioContext`.
- `src/services/audioCapture.js` and `src/services/interviewMessages.js` — pure capture helpers and client message encoders.
- `src/components/TranscriptLog.jsx` — text-only transcript with near-bottom auto-scroll.

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
