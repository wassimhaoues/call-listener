# Linux Desktop Support Plan

Status: active Phase 0 workstream. The tested capability module, the platform-audio adapter extraction (L1), and the diagnostics screen are complete. The first L2 slice (a candidate-selected PipeWire/PulseAudio monitor source as interviewer audio) is implemented and unit-tested. A real PipeWire probe showed that stock Electron does not list monitor sources, so the slice helps only where a monitor is exposed as a regular input; live Ubuntu qualification and Electron desktop-audio capture remain pending. It extends the candidate-facing application; it does not add interviewer-facing features.

## Supported baseline

Initial Linux target: Ubuntu 24.04 LTS on x86_64 with PipeWire and WirePlumber. Test both X11 and Wayland, then release only combinations that pass the capture matrix. This development host meets the software baseline: PipeWire 1.0.5 and WirePlumber are active, with microphone and output devices visible. That verifies the environment, not app capture.

The candidate uses the same preparation, interview, and debrief workspace on both platforms. The backend, WebSocket protocol, models, profile, job-offer context, and privacy model remain shared.

## Audio design

Introduce a platform-audio interface in the Electron main process:

| Method | Windows implementation | Linux implementation |
| --- | --- | --- |
| `getCapabilities()` | Check SoundVolumeView and VB-Cable | Detect desktop-audio and monitor-source availability |
| `prepare()` | Recover routing and ensure tools exist | Request candidate-approved capture; do not change default devices |
| `startSystemCapture()` | Existing VB-Cable input | Prefer PipeWire desktop audio; fall back to a selected monitor source |
| `stop()` | Disable routing and restore playback | Stop only streams created by the app |
| `recover()` | Restore saved playback after a crash | Clear local capture state |

Implemented interface (L1, `services/platformAudio/index.js`): `prepare()`, `ensureReady()`, `offerDeviceInstall()`, `waitForDevice()`, `enableRouting()`, `disableRouting()`, `isRoutingActive()`, `recoverIfDirty()`, `onSuspend()`/`onResume()`, `gracefulExit()`, and `describe()`; capabilities still come from `services/platformCapabilities.js`. `startSystemCapture()` is deferred to L2.

The renderer receives a platform-neutral capability/stream result through narrow preload IPC. It must not depend on `SoundVolumeView.exe`, PowerShell, `pactl`, or platform-specific device IDs.

Linux capture order:

1. Electron/Chromium desktop-audio capture, initiated by a real candidate consent action; discard the video track when only audio is needed.
2. A visible PipeWire/PulseAudio monitor source selected through normal media-device permission.
3. Microphone-only interview mode with typed-question support and a clear diagnostic.

Do not install drivers, create virtual sinks, run sound-server commands, or alter the Linux default output automatically. Electron documents PipeWire-specific capture behavior on Linux, including a single source in some cases; system-audio capture is a runtime capability, not an assumption. [Electron desktop capture documentation](https://www.electronjs.org/docs/latest/api/desktop-capturer/)

## Implementation phases

### L0 — Linux baseline and test harness

- [x] Add a tested pure platform-capability module with Windows, Linux, and unsupported-platform fixtures.
- [x] Add a diagnostic screen with OS, display server, capture strategy, audio adapter state, versions, and actionable errors without host identifiers. `/diagnostics` (header activity button) reads `window.callApi.getDiagnostics()`; `services/diagnostics.js` whitelists fields and maps error codes to fixed copy, with a test that hostnames, user names, home paths, IPs, installation IDs, and raw error text never appear. Since L2's first slice it also shows the kind of interviewer source chosen in Setup ("Monitor source selected", "VB-Cable", or "None (typed questions)"), never a device ID or label.
- [ ] Validate Ubuntu startup and microphone-only mode. A local live check on this host (Ubuntu, X11, production renderer build run through Electron 44 with `--no-sandbox`, fake token server) reached Setup in microphone-only mode and showed the diagnostics page; with a backend that accepts but never answers, the window showed "Connecting…" immediately and the server-unreachable page after the 10 s auth timeout. Still open: a real backend session, Wayland, a packaged AppImage/`.deb`, and an actual microphone interview.

Exit gate: the shared candidate workspace opens on Linux without Windows-only dependencies.

### L1 — Platform adapter extraction

- [x] Put the existing Windows route manager behind the shared interface without behavior changes. `services/platformAudio/windowsAdapter.js` wraps `AudioRouteManager`, and `services/audio.js` itself is untouched; tests assert the adapter calls the manager in the same order the old `main.js` did for startup, crash recovery, polling, and exit. Adapter-level additions: redundant enable/disable calls are skipped, routing changes are serialized, `gracefulExit()` runs once, and routing is never re-enabled after exit. Windows CI (install smoke, VB-Cable restoration) remains the regression gate.
- [x] Add a Linux adapter that owns only app-created streams. `services/platformAudio/linuxAdapter.js` runs no commands, changes no OS routing, stops only streams registered through `trackStream()`, and reports microphone-only capture until L2.
- [x] Replace the `win32` block with capability-based routing. `main.js` startup, tray, `powerMonitor` suspend/resume, quit cleanup, and IPC call the adapter chosen by `createPlatformAudio()` from `getPlatformCapabilities()`. The only remaining `win32` check sets the Windows AppUserModelID (shell identity, not audio).
- [x] Unit-test adapter choice, idempotent lifecycle, and errors without running platform commands (`test/platformAudio.test.js`, an injected fake manager with the `AudioRouteManager` public API, and injected `fs`/logger).

Exit gate: Windows regressions pass and Linux completes microphone-only mode.

### L2 — Linux system-audio capture

- [ ] Add Electron desktop-capture permission handling and user-initiated selection.
- [ ] Feed normalized Linux system audio into the existing PCM pipeline while retaining candidate/interviewer labels. Monitor-source path done in code: a chosen monitor is captured as the `system` source with the same unprocessed mono 48 kHz constraints and AudioWorklet/PCM16 path as VB-Cable, while the microphone stays `mic`. Still open: the Electron desktop-capture path and confirming on real PipeWire that monitor audio arrives and is transcribed as interviewer speech.
- [x] Add monitor-source fallback with refreshable labels. On Linux the capability carries `systemAudio.selectableSource: "monitor-source"`. Setup lists `audioinput` devices whose label is "Monitor of …" (also "Default - Monitor of …") or a raw `*.monitor` source name (`src/services/monitorSources.js`) as an optional "Interviewer audio (system output)" source. "None" (microphone only with typed questions) is the default. A saved monitor is never restored automatically, and monitors are never offered as microphones. Hidden labels show an explicit "Allow audio access" step: one `getUserMedia({ audio: true })` whose tracks are stopped at once. Refresh lists the devices again and drops a choice whose device is gone. Matching also covers "Remapped Monitor of …". Limitation: translated descriptions (for example "Monitor von …") are not recognised, and such a monitor can appear in the microphone list under its translated name. Real-host finding: a probe on this host (Electron 44, PipeWire 1.0.5, X11, permission granted) found no monitor among the `audioinput` devices, only the default entry and the microphone. Chromium's PulseAudio backend leaves monitor sources out, so on a stock Ubuntu PipeWire setup Setup shows the "no monitor sources visible" state and the candidate stays in typed-question mode. A monitor is offered only when the system exposes it as a regular input (for example a `module-remap-source` the user created). Capture from such a source has not been validated, so the Electron desktop-capture item above remains the main route.
- [ ] Test consent denial, missing PipeWire, X11, Wayland, stop/reselect, suspend/resume, and reconnect. Unit-tested so far with mocks: permission denial in Setup, no monitor found, refresh after a device change, and loss of the monitor mid-interview. When the system track ends, only that source is stopped and the candidate sees a notice, then typed questions take over; the microphone keeps running and no interviewer speech is generated. Real sessions on X11 and Wayland, suspend/resume, and reconnect still need testing.

Exit gate: final interviewer audio is transcribed in a real Ubuntu PipeWire session and all capture tracks stop after Stop.

### L3 — Distribution and release

- [x] Declare AppImage and `.deb` electron-builder targets with desktop metadata. Developer `.deb` packages use gzip for practical local build times. Both package targets build successfully; clean-install and desktop integration validation remain.
- [ ] Test clean install, upgrade, launch, permissions, audio capability, uninstall, and updater behavior.
- [ ] Document supported desktop environments and audio limitations.

Exit gate: a clean Ubuntu install passes the candidate interview workflow and platform audio tests.

## Required matrix

| Scenario | Ubuntu 24.04 X11 | Ubuntu 24.04 Wayland | Windows |
| --- | --- | --- | --- |
| Candidate workspace | Required | Required | Required regression |
| Microphone capture | Required | Required | Required regression |
| PipeWire desktop audio | Required | Required | N/A |
| Monitor-source fallback | When exposed | When exposed | N/A |
| VB-Cable recovery | N/A | N/A | Required regression |
| Package lifecycle | AppImage and/or `.deb` | AppImage and/or `.deb` | NSIS |

Ship Linux as an opt-in pilot after L2. The app must remain useful in microphone-only mode and must never fabricate interviewer speech when system audio is unavailable.
