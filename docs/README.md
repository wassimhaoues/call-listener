# Project Documentation

Call Listener is a Windows desktop assistant for live telephone conversations. The Electron client captures microphone and system audio, the backend transcribes French speech through Deepgram, and Groq produces concise in-call suggestions.

## Documentation map

- [Candidate interview enhancement plan](plan/README.md) — proposed product direction, phased implementation, architecture, validation, and starting backlog.
- [Getting started](getting-started.md) — prerequisites, configuration, and local commands.
- [Architecture](architecture.md) — components and end-to-end data flow.
- [Backend](backend.md) — API, session lifecycle, storage, and integrations.
- [Desktop client](desktop-client.md) — Electron, renderer, audio routing, and packaging.
- [WebSocket protocol](protocols/websocket.md) — authenticated message contract.
- [Deployment](deployment.md) — Docker Compose, Redis, Traefik, and operations.
- [Troubleshooting](troubleshooting.md) — common startup and audio failures.

## Repository map

| Path | Purpose |
| --- | --- |
| `Call_listener_Backend/` | Express/WebSocket service, Dockerfile, Compose stack, and logs. |
| `Call_Listener_Frontend/v-0/` | Electron main process, React/Vite renderer, Windows audio integrations, and packaged output. |
| `docs/` | Maintained project documentation. |

The source of truth is the code and its package scripts. Update the relevant page in this directory whenever a configuration variable, API message, deployment setting, or user-facing flow changes.
