#!/usr/bin/env bash
# Set the backend's provider keys on the server from your laptop, then
# restart the backend and check its health.
#
# Usage: scripts/deploy/set-secrets.sh [ssh-host] [env-file-on-server]
#   defaults: yes-sir-app  /home/deploy/call-listener/caller.env
#
# Keys are typed with hidden input and sent over the SSH connection's stdin:
# they never appear in a command line, your shell history, or this terminal.
# Press Enter at a prompt to keep the value already on the server.
set -euo pipefail

HOST="${1:-yes-sir-app}"
ENV_FILE="${2:-/home/deploy/call-listener/caller.env}"
REPO_DIR="$(dirname "$ENV_FILE")/repo/Call_listener_Backend"

KEYS=(DEEPGRAM_API_KEY OPENROUTER_API_KEY)
declare -A VALUES=()

echo "Setting secrets in $ENV_FILE on $HOST (input is hidden; Enter keeps the current value)."
for key in "${KEYS[@]}"; do
  read -r -s -p "$key: " value
  echo
  if [[ -n "$value" ]]; then
    if [[ "$value" =~ [[:space:]] ]]; then
      echo "error: $key contains whitespace; nothing was changed." >&2
      exit 2
    fi
    VALUES[$key]="$value"
  fi
done

if [[ ${#VALUES[@]} -eq 0 ]]; then
  echo "Nothing to change."
  exit 0
fi

# Remote updater: reads KEY=VALUE lines on stdin, replaces or appends them in
# the env file atomically with mode 0600, and prints only the key names.
REMOTE_UPDATE=$(cat <<'PY'
import os, sys, tempfile
path = sys.argv[1]
updates = {}
for line in sys.stdin.read().splitlines():
    if "=" in line:
        key, value = line.split("=", 1)
        updates[key] = value
with open(path) as handle:
    lines = handle.read().splitlines()
seen = set()
out = []
for line in lines:
    key = line.split("=", 1)[0] if "=" in line and not line.lstrip().startswith("#") else None
    if key in updates:
        out.append(f"{key}={updates[key]}")
        seen.add(key)
    else:
        out.append(line)
out += [f"{key}={value}" for key, value in updates.items() if key not in seen]
directory = os.path.dirname(path)
fd, tmp = tempfile.mkstemp(dir=directory, prefix=".caller.env.")
with os.fdopen(fd, "w") as handle:
    handle.write("\n".join(out) + "\n")
os.chmod(tmp, 0o600)
os.replace(tmp, path)
print("updated: " + ", ".join(sorted(updates)))
PY
)

for key in "${!VALUES[@]}"; do
  printf '%s=%s\n' "$key" "${VALUES[$key]}"
done | ssh "$HOST" "python3 -c $(printf '%q' "$REMOTE_UPDATE") $(printf '%q' "$ENV_FILE")"
unset VALUES

echo "Restarting the backend with the new configuration..."
ssh "$HOST" "cd $(printf '%q' "$REPO_DIR") && docker compose -f call-listener-stack.yml --env-file $(printf '%q' "$ENV_FILE") -p call-listener up -d --no-build --force-recreate backend >/dev/null 2>&1 && for i in \$(seq 1 30); do s=\$(docker inspect --format '{{.State.Health.Status}}' call-backend); [ \"\$s\" = healthy ] && break; sleep 2; done; echo \"backend: \$s\""

echo "Done. Verify from here with: node scripts/deploy/smoke.mjs https://<your-domain>"
