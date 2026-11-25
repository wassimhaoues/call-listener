# Desktop Client

The desktop application lives in `Call_Listener_Frontend/v-0/`. It combines Electron, Vite, React, React Router, Tailwind, and Framer Motion.

## Main process and security

`main.js` creates the window and tray, performs authentication, selects platform capabilities, controls auto-updates, and restores Windows audio settings on exit. Windows follows the VB-Cable/SoundVolumeView gate; Linux skips those tools and enters microphone-only mode until PipeWire desktop capture is qualified. `preload.js` exposes only the explicit `getWsUrl()`, `getPlatformCapabilities()`, and `getModels()` methods. `getModels()` asks the main process to call the backend `GET /models` with its own `call_token`; the renderer receives only model IDs, names, and availability (or `null` on failure), never the token. The Interview Settings step shows the catalog as an "AI model" picker: unavailable models are listed but disabled, the server default is used when nothing is chosen or the catalog cannot be loaded, and a saved choice that is no longer offered is cleared with a visible notice rather than silently replaced. `services/security.js` restricts media permissions to the packaged page or local Vite origin, injects the development guard header, and sets a production content-security policy.

Do not enable Node integration or disable context isolation. Keep tokens in `AuthManager` in the main process. Production navigation opens external URLs through the system shell rather than inside the application.

## Renderer and routing

`src/App.jsx` uses `HashRouter`. The normal sequence is `/` (device setup), `/context` (legacy caller/user data, pending candidate/job migration), then `/conversation` (live audio). Supporting pages display authentication, unsupported-OS, and missing-VB-Cable states. Shared page chrome and theme state are in `src/layout/` and `src/ui/UIContext.jsx`.

The conversation page captures two distinct `audioinput` devices when system capture is available. In Linux microphone-only mode it captures just the candidate microphone and clearly identifies interviewer audio as unavailable. `src/worklets/pcm-processor.js` is preferred; the page falls back to `ScriptProcessor` if worklets fail. Both paths emit PCM16, mono, 48 kHz chunks to the backend. UI device and legacy context selections are stored in localStorage.

`src/pages/Conversation.jsx` only composes and renders the live workspace. Its logic lives in tested modules:

- `src/services/conversationState.js` — pure reducer for status, transcript entries, the current (latest) interviewer question, pending/thinking guidance, stale-guidance hiding, terminal failure/budget states, pause, and dropped-audio counts. Incoming server messages pass through an ordered list of handlers.
- `src/hooks/useInterviewSocket.js` — opens the socket from `window.callApi.getWsUrl()`, sends stored context on open, routes every socket event to one `dispatch`, applies audio backpressure, sends typed questions, and ends idempotently (also on unmount).
- `src/hooks/useAudioCapture.js` — getUserMedia, AudioWorklet (or `ScriptProcessor` fallback) graph, meter levels, flush, and idempotent release of tracks and the `AudioContext`.
- `src/services/audioCapture.js` and `src/services/interviewMessages.js` — pure capture helpers and client message encoders.
- `src/components/TranscriptLog.jsx` — text-only transcript with near-bottom auto-scroll.

## Windows audio routing

`AudioRouteManager` uses bundled SoundVolumeView to detect VB-Cable, save the prior playback device, enable “listen to this device,” and restore settings on a clean exit. It writes recovery state to Electron user data and starts `watchdog.js` so a crashed app also restores the device. VB-Cable installation requires elevation. Test routing carefully: it changes the Windows default playback device.

## Linux baseline

Linux is an unqualified, microphone-only development path. It must not invoke VB-Cable installation, SoundVolumeView, audio routing, or the Windows watchdog. PipeWire desktop audio, monitor-source fallback, packaging, and real Electron startup validation remain tracked in the [Linux support plan](plan/08-linux-support.md).
