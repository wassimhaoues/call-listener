# Troubleshooting

## Backend does not start

`server/config/env.js` fails fast when a required variable is missing. Check all required keys in the local environment and verify that `REDIS_URL` can reach Redis. Use `GET /health` for process liveness and `GET /ready` for Redis readiness. The backend log files in `Call_listener_Backend/logs/` separate core, Redis, WebSocket, Deepgram, and AI output.

## Authentication or socket failure

Confirm the backend `APP_ID` matches `com.coworky.calllistener`, the desktop points at the intended `CALL_HOST`, and HTTPS/WSS certificates are valid. A rejected WebSocket closes with code `4001`; obtain a new token through `/auth/token` and inspect backend WebSocket logs. Do not attempt to work around the failure by exposing the JWT to renderer code.

If Electron reports `ERR_TLS_CERT_ALTNAME_INVALID`, inspect the certificate served for the exact `CALL_HOST`. For example, `call.coworky.org` must be covered by the certificate's Subject Alternative Name; a certificate for the VPS hostname is not valid for the application domain. Correct the Traefik router/certificate resolver and DNS on the deployment host, then verify `https://call.coworky.org/health` before retrying. Do not disable certificate validation or switch the client to the VPS hostname as a workaround.

## No system audio or no audio meters

On Windows, grant microphone permission, select the physical microphone and VB-Cable (or a supported loopback) separately, and ensure VB-Cable is installed. If the app exits unexpectedly, launch it again: the audio manager checks recovery state and restores the previous default device. If routing still looks wrong, disable routing from the tray or restore the Windows default playback device manually. Linux currently supports a microphone-only development path; PipeWire system-audio capture is not qualified yet.

## No transcripts or suggestions

Verify a 48 kHz PCM stream is reaching the WebSocket and that chunks use `mic` or `system`. Deepgram emits only final utterances at utterance end. Suggestions are generated only after context is received or after a final `system` utterance; check Deepgram and Groq credentials, provider availability, and the 12-second AI timeout logs.
