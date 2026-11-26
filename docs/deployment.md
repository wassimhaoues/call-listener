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

Traefik routes `https://$CALLER_DOMAIN` to Express on port 3000 and `wss://$CALLER_DOMAIN/ws` (the rule matches `/ws` and `/ws/...` exactly, not every `/ws*` path, so `POST /ws-ticket` reaches Express) to the WebSocket server on port 4000. TLS is required because the auth cookie is `Secure` and desktop media access is designed for secure contexts. The labels configure HSTS, frame denial, no-sniff, no-referrer, and a 50-average/100-burst rate limit. Express additionally limits `POST /auth/token` per client IP; the stack sets `TRUST_PROXY_HOPS=1` so Express reads the client address from Traefik's `X-Forwarded-For`.

## Operational checks

- Check `/health` for liveness and `/ready` for Redis-backed readiness after deploy.
- Tail backend logs for authentication, WebSocket, Deepgram, and AI failures.
- Rotate `JWT_SECRET`, provider keys, and Redis credentials through the secret store; never put their values in documentation or source control.
- Verify that the desktop `CALL_HOST`, backend `APP_ID`, and proxy hostname agree before releasing a desktop build.

## Revoking an installation

To cut off one installation (abuse, a lost laptop, a leaked token), add its device ID to the deny-list. Get the ID from the candidate: it is the UUID in the desktop's user-data `installation-id` file. Revocation logs and CLI output name a device only by a 12-character fingerprint of its hash.

Run the CLI where `REDIS_URL` is set: inside the backend container, which already has it, or from `Call_listener_Backend/` with a local `.env`:

```bash
docker compose -f call-listener-stack.yml exec backend npm run admin:revocation -- check <device-id>
npm run admin:revocation -- revoke <device-id> --reason "ticket 142"
npm run admin:revocation -- check <device-id>
npm run admin:revocation -- restore <device-id>
```

The reason is an operator code (at most 120 characters of letters, digits, spaces and `_ . : # / -`); never put names, emails, or other personal data in it. Exit codes: `0` success, `1` Redis failure (the message shows only an error code, never `REDIS_URL`), `2` invalid arguments. The device ID appears in your shell history, so run the command in a session whose history you do not keep or share.

After `revoke`, new tokens, tickets, HTTP requests and WebSocket connections from that installation are refused immediately (`403`/`4003 device_revoked`), and its open sockets close within `REVOCATION_SWEEP_MS` (default one minute) on every backend instance. `restore` re-enables it at once. Limits: until installations are enrolled with revocable credentials, a user can reset the desktop's installation ID and come back as a new device; `REVOCATION_FAIL_CLOSED` (default `false`) decides whether a Redis outage lets requests through (logged) or refuses all new authentication (see [Device revocation](backend.md#device-revocation)). Redis persistence (`redis-data`) keeps the deny-list across restarts; restoring Redis from an old backup can drop recent revocations.

## Installation enrollment

Desktop builds that include enrollment send a per-installation secret on sign-in, and the backend binds it to the installation ID on first use ([details](backend.md#installation-enrollment)). Roll it out in this order:

1. Deploy the backend with `ENROLLMENT_REQUIRED=false` (the default). Old and new desktops both sign in.
2. Ship the desktop build. Each installation enrolls on its next sign-in, keeping its installation ID.
3. When every pilot installation runs the new build, set `ENROLLMENT_REQUIRED=true` so an ID without its secret is refused.

When a candidate's stored secret is lost (for example the app data was copied to another computer, or the OS key store was reset), the desktop starts over as a new installation by itself. If an installation still reports "could not be verified", run `npm run admin:revocation -- reset-enrollment <device-id>`. Its next sign-in enrolls a new secret. The device ID lands in your shell history, as for revocation.

## Desktop release builds

`.github/workflows/release.yml` builds desktop artifacts when a `vX.Y.Z` tag is pushed (or via manual dispatch with an existing tag):

1. Set `version` in `Call_Listener_Frontend/v-0/package.json`, merge, then tag that commit `vX.Y.Z` and push the tag. The workflow refuses a tag that does not match the package version.
2. The Windows job downloads SoundVolumeView and VB-Cable with `fetch-windows-deps.ps1 -Strict`, so it fails unless each download matches a reviewed SHA-256 listed in that script. When NirSoft updates SoundVolumeView, review the new release and add its hash before tagging.
3. Windows NSIS and Linux deb/AppImage packages are built, smoke-tested (install/launch/uninstall), and attached with a `SHA256SUMS` file to a **draft** GitHub Release.
4. A maintainer reviews the draft and publishes it manually. The workflow never publishes, and refuses to modify a release that is already published.

Builds are unsigned (no code-signing certificate is configured), and `electron-updater` has no publish feed configured, so installed clients do not auto-update from these releases.
