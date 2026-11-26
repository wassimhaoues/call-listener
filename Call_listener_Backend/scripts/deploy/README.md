# Deploying the backend to a VPS

The backend runs as a Docker Compose project (`call-listener`) with its own Redis, behind a Traefik that already runs on the host. Traefik uses the Docker provider, the external network `edge-net`, the `websecure` entrypoint, and the Let's Encrypt resolver `le`. The compose file is `call-listener-stack.yml`.

## Layout on the server

```
/home/deploy/call-listener/
├── caller.env   # config + secrets, mode 0600, never committed
└── repo/        # git checkout of this repository
```

`caller.env` holds:

| Key | Set by | Notes |
| --- | --- | --- |
| `CALLER_DOMAIN` | setup | Public host, for example `caller.staging.yes-sir.tech`. Used for the Traefik rules and the cookie domain. |
| `CALLER_ENV_FILE` | setup | Absolute path of this file; compose reads it as the backend's env file. |
| `APP_ID` | setup | Must equal the desktop's `AUTH_APP_ID` (`com.coworky.calllistener`). |
| `AI_PROVIDER`, `JWT_TTL_SECONDS`, `ENROLLMENT_REQUIRED` | setup | `openrouter`, `900`, `false`. Set `ENROLLMENT_REQUIRED=true` once every desktop runs an enrolling build. |
| `JWT_SECRET`, `REDIS_PASSWORD` | setup | Generated on the server with `openssl rand`; never printed. |
| `DEEPGRAM_API_KEY`, `OPENROUTER_API_KEY` | you, with `set-secrets.sh` | Placeholders (`__SET_ME__`) until set. |

Any other backend variable (budgets, model allowlist and prices, limits; see `docs/getting-started.md`) can be added to the same file.

## Scripts (run from your laptop, in `Call_listener_Backend/`)

- `scripts/deploy/set-secrets.sh [ssh-host]` prompts for the provider keys with hidden input. It sends them over SSH stdin (never in a command line or shell history), updates `caller.env` atomically with mode 0600, recreates the backend container, and waits for it to be healthy. Press Enter to keep a value.
- `scripts/deploy/deploy.sh [git-ref] [ssh-host]` fetches a branch or tag on the server, rebuilds the image, restarts, waits for health, and prunes only this project's dangling images (the server is shared).
- `node scripts/deploy/smoke.mjs https://<domain>` checks TLS, `/health`, `/ready`, enrollment with a synthetic installation, a refused wrong secret, `/auth/me`, `/ws-ticket`, the WebSocket handshake, and that a reused ticket is refused. It sends no context, audio, or question, so it never calls a paid provider. Each run enrolls one throwaway `smoke-…` installation in Redis.

## Operations

- Logs: `docker logs -f call-backend` (JSON lines at `info`; transcripts are never logged).
- Status: `docker ps --filter name=call-`.
- Revoke or reset an installation: `docker exec call-backend npm run admin:revocation -- revoke <device-id>` (or `restore`, `check`, `reset-enrollment`).
- Redis persists to the `call-listener_redis-data` volume (AOF, `noeviction`). Revocations and enrollments have no expiry, so back that volume up with the server's other volumes.
- Stop everything: `docker compose -f call-listener-stack.yml --env-file /home/deploy/call-listener/caller.env -p call-listener down`. Add `-v` only if you mean to delete Redis data.
