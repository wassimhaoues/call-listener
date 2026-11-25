# Deployment and Operations

`Call_listener_Backend/call-listener-stack.yml` runs Redis 7 and the backend container. The backend image uses Node 20 Alpine, installs production dependencies with `npm ci --omit=dev`, runs as an unprivileged user, and exposes HTTP `3000` plus WebSocket `4000`.

## Compose deployment

From `Call_listener_Backend/`, inject application secrets through your deployment secret store or a local Compose environment file; never copy an environment file into the image. The Docker build context excludes `.env*` files. Supply `REDIS_PASSWORD` separately, then run:

```bash
docker compose -f call-listener-stack.yml up --build -d
docker compose -f call-listener-stack.yml logs -f backend
```

The stack creates an internal `callnet` network and requires the external Docker network `edge-net`. Redis is not published externally. Its persistent volume is `redis-data` and it requires a password.

## Reverse proxy

Traefik routes `https://call.coworky.org` to Express on port 3000 and `wss://call.coworky.org/ws` to the WebSocket server on port 4000. TLS is required because the auth cookie is `Secure` and desktop media access is designed for secure contexts. The labels configure HSTS, frame denial, no-sniff, no-referrer, and a 50-average/100-burst rate limit.

## Operational checks

- Check `/health` for liveness and `/ready` for Redis-backed readiness after deploy.
- Tail backend logs for authentication, WebSocket, Deepgram, and AI failures.
- Rotate `JWT_SECRET`, provider keys, and Redis credentials through the secret store; never put their values in documentation or source control.
- Verify that the desktop `CALL_HOST`, backend `APP_ID`, and proxy hostname agree before releasing a desktop build.
