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

Traefik routes `https://call.coworky.org` to Express on port 3000 and `wss://call.coworky.org/ws` (the rule matches `/ws` and `/ws/...` exactly, not every `/ws*` path, so `POST /ws-ticket` reaches Express) to the WebSocket server on port 4000. TLS is required because the auth cookie is `Secure` and desktop media access is designed for secure contexts. The labels configure HSTS, frame denial, no-sniff, no-referrer, and a 50-average/100-burst rate limit. Express additionally limits `POST /auth/token` per client IP; the stack sets `TRUST_PROXY_HOPS=1` so Express reads the client address from Traefik's `X-Forwarded-For`.

## Operational checks

- Check `/health` for liveness and `/ready` for Redis-backed readiness after deploy.
- Tail backend logs for authentication, WebSocket, Deepgram, and AI failures.
- Rotate `JWT_SECRET`, provider keys, and Redis credentials through the secret store; never put their values in documentation or source control.
- Verify that the desktop `CALL_HOST`, backend `APP_ID`, and proxy hostname agree before releasing a desktop build.

## Desktop release builds

`.github/workflows/release.yml` builds desktop artifacts when a `vX.Y.Z` tag is pushed (or via manual dispatch with an existing tag):

1. Set `version` in `Call_Listener_Frontend/v-0/package.json`, merge, then tag that commit `vX.Y.Z` and push the tag. The workflow refuses a tag that does not match the package version.
2. The Windows job downloads SoundVolumeView and VB-Cable with `fetch-windows-deps.ps1 -Strict`, so it fails unless each download matches a reviewed SHA-256 listed in that script. When NirSoft updates SoundVolumeView, review the new release and add its hash before tagging.
3. Windows NSIS and Linux deb/AppImage packages are built, smoke-tested (install/launch/uninstall), and attached with a `SHA256SUMS` file to a **draft** GitHub Release.
4. A maintainer reviews the draft and publishes it manually. The workflow never publishes, and refuses to modify a release that is already published.

Builds are unsigned (no code-signing certificate is configured), and `electron-updater` has no publish feed configured, so installed clients do not auto-update from these releases.
