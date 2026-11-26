#!/usr/bin/env bash
# Deploy (or update) the backend on the server from your laptop: pull a git
# ref, rebuild the image, restart, and wait for the health check.
#
# Usage: scripts/deploy/deploy.sh [git-ref] [ssh-host] [deploy-dir]
#   defaults: main  yes-sir-app  /home/deploy/call-listener
# The server keeps its config and secrets in <deploy-dir>/caller.env (see
# scripts/deploy/README.md); this script never reads or prints them.
set -euo pipefail

REF="${1:-main}"
HOST="${2:-yes-sir-app}"
DIR="${3:-/home/deploy/call-listener}"

ssh "$HOST" bash -s -- "$REF" "$DIR" <<'REMOTE'
set -euo pipefail
REF="$1"; DIR="$2"; ENV="$DIR/caller.env"
[ -f "$ENV" ] || { echo "missing $ENV (create it first, see README)"; exit 1; }
cd "$DIR/repo"
git fetch -q --prune origin
git checkout -q --detach "origin/$REF" 2>/dev/null || git checkout -q --detach "$REF"
echo "Deploying $(git log --oneline -1)"
cd Call_listener_Backend
docker compose -f call-listener-stack.yml --env-file "$ENV" -p call-listener up -d --build 2>&1 | tail -3
for i in $(seq 1 45); do
  status=$(docker inspect --format '{{.State.Health.Status}}' call-backend 2>/dev/null || echo missing)
  [ "$status" = healthy ] && break
  sleep 2
done
echo "backend: $status"
# Only this project's dangling images: the server is shared.
docker image prune -f --filter label=com.docker.compose.project=call-listener >/dev/null
[ "$status" = healthy ]
REMOTE
