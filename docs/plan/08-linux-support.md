# Linux Desktop Support Plan

Status: active Phase 0 workstream. The tested capability module is complete; runtime integration and capture qualification remain pending. It extends the candidate-facing application; it does not add interviewer-facing features.

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

The renderer receives a platform-neutral capability/stream result through narrow preload IPC. It must not depend on `SoundVolumeView.exe`, PowerShell, `pactl`, or platform-specific device IDs.

Linux capture order:

1. Electron/Chromium desktop-audio capture, initiated by a real candidate consent action; discard the video track when only audio is needed.
2. A visible PipeWire/PulseAudio monitor source selected through normal media-device permission.
3. Microphone-only interview mode with typed-question support and a clear diagnostic.

Do not install drivers, create virtual sinks, run sound-server commands, or alter the Linux default output automatically. Electron documents PipeWire-specific capture behavior on Linux, including a single source in some cases; system-audio capture is a runtime capability, not an assumption. [Electron desktop capture documentation](https://www.electronjs.org/docs/latest/api/desktop-capturer/)

## Implementation phases

### L0 — Linux baseline and test harness

- [x] Add a tested pure platform-capability module with Windows, Linux, and unsupported-platform fixtures.
- [ ] Add a diagnostic screen with OS, display server, capture strategy, selected sources, and actionable errors without host identifiers.
- [ ] Validate Ubuntu startup and microphone-only mode; source-level branching and renderer tests skip Windows installer, route manager, and watchdog code, and microphone-only mode now provides a bounded typed-question fallback, but a live Electron check is still required.

Exit gate: the shared candidate workspace opens on Linux without Windows-only dependencies.

### L1 — Platform adapter extraction

- [ ] Put the existing Windows route manager behind the shared interface without behavior changes.
- [ ] Add a Linux adapter that owns only app-created streams.
- [ ] Replace the `win32` block with capability-based routing.
- [ ] Unit-test adapter choice, idempotent lifecycle, and errors without running platform commands.

Exit gate: Windows regressions pass and Linux completes microphone-only mode.

### L2 — Linux system-audio capture

- [ ] Add Electron desktop-capture permission handling and user-initiated selection.
- [ ] Feed normalized Linux system audio into the existing PCM pipeline while retaining candidate/interviewer labels.
- [ ] Add monitor-source fallback with refreshable labels.
- [ ] Test consent denial, missing PipeWire, X11, Wayland, stop/reselect, suspend/resume, and reconnect.

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
