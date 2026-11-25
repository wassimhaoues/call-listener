# Repository Guidelines

## Project Structure & Module Organization

This workspace contains two independent Node.js projects. `Call_listener_Backend/` is the realtime API: `server/index.js` starts Express and WebSocket services; `server/config/` loads configuration; `server/services/` contains AI, chat, transcription, and watchdog logic; and `server/core/` holds shared utilities and logging. Runtime logs belong in `Call_listener_Backend/logs/`.

`Call_Listener_Frontend/v-0/` is the Electron desktop client. Keep Electron entry points in `main.js` and `preload.js`, native integrations in `services/`, and React UI in `src/` (`pages/`, `components/`, `layout/`, `ui/`, and `worklets/`). Treat `dist/` and `bin/` as generated or bundled artifacts; do not hand-edit them.

## Build, Test, and Development Commands

Run commands from the relevant project directory, after `npm ci` (or `npm install`).

- `cd Call_listener_Backend && npm run dev` starts the backend in development mode.
- `cd Call_listener_Backend && npm start` runs it in production mode.
- `cd Call_listener_Backend && npm test` runs the backend unit, HTTP integration, and AI-framework compatibility tests; `npm run lint` remains a placeholder.
- `cd Call_Listener_Frontend/v-0 && npm run dev` runs Vite and Electron together.
- `cd Call_Listener_Frontend/v-0 && npm run build` builds the renderer and packages the Windows installer.
- `cd Call_Listener_Frontend/v-0 && npm start` launches Electron without Vite.
- `cd Call_Listener_Frontend/v-0 && npm test` runs the Vitest renderer and utility tests.

## Coding Style & Naming Conventions

Use ES modules, semicolons, double-quoted strings, and two-space indentation, matching existing files. Name React components and component files in PascalCase (for example, `StatusBar.jsx`); use camelCase for functions, variables, services, and utility modules (for example, `streamManager.js`). Keep backend concerns within their existing layer and use the shared logger rather than ad-hoc console output.

## Testing Guidelines

Backend tests use Node's built-in test runner; frontend tests use Vitest with React Testing Library. There is no coverage target yet. For every change, run the affected app and exercise its changed flow; add focused tests beside testable logic using names such as `streamManager.test.js` or `StatusBar.test.jsx`.

## Commit & Pull Request Guidelines

Git metadata is not present in this checkout, so no local commit convention can be verified. Use short, imperative Conventional Commit-style subjects, such as `fix: reconnect websocket after Redis failure`. Keep commits scoped. Pull requests should explain behavior changes, list validation commands, link relevant issues, and include screenshots or recordings for UI changes.

## Security & Configuration

The backend reads credentials from `Call_listener_Backend/.env` (including Deepgram, Groq or OpenRouter, Redis, and JWT settings). Never commit, log, or paste secrets; use local environment files or the deployment secret store instead.
