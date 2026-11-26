#!/usr/bin/env bash
# Linux package lifecycle smoke test for CI (Ubuntu, X11 via Xvfb).
# Installs the .deb, launches it, records a screenshot and logs, uninstalls it,
# then launches the AppImage the same way.
# Usage: scripts/ci/smoke-linux.sh <deb> <AppImage> [outDir] [runSeconds]
set -euo pipefail

DEB="$(realpath "$1")"
APPIMAGE="$(realpath "$2")"
OUT="$(realpath -m "${3:-ci-linux-smoke}")"
RUN_SECONDS="${4:-20}"
mkdir -p "$OUT"
export DISPLAY="${DISPLAY:-:99}"

launch_and_check() {
  local label="$1"; shift
  echo "== Launching $label: $*"
  # Own process group, so the app and its helper processes stop together.
  setsid "$@" >"$OUT/$label-stdout.log" 2>"$OUT/$label-stderr.log" &
  local pid=$!
  sleep "$RUN_SECONDS"
  import -window root "$OUT/$label.png" || echo "screenshot failed"
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "$label exited early"; cat "$OUT/$label-stdout.log" "$OUT/$label-stderr.log"
    return 1
  fi
  echo "$label still running after ${RUN_SECONDS}s"
  kill -- "-$pid" 2>/dev/null || true
  sleep 2
  kill -9 -- "-$pid" 2>/dev/null || true
}

echo "== Installing $DEB"
sudo apt-get install -y "$DEB"
PKG="$(dpkg-deb -f "$DEB" Package)"
# The package registers its executable as /usr/bin/<package> via update-alternatives.
BIN="$(readlink -f "/usr/bin/$PKG" || true)"
DESKTOP="$(dpkg -L "$PKG" | grep -E '\.desktop$' || true)"
DESKTOP="${DESKTOP%%$'\n'*}"
echo "Binary: $BIN"; echo "Desktop entry: $DESKTOP"
du -sh "$(dirname "$BIN")" | tee "$OUT/install-size.txt"
[ -n "$BIN" ] || { echo "installed binary not found"; exit 1; }
[ -n "$DESKTOP" ] && desktop-file-validate "$DESKTOP" | tee "$OUT/desktop-validate.txt" || true
SANDBOX="$(dirname "$BIN")/chrome-sandbox"
[ -f "$SANDBOX" ] && stat -c '%U %a %n' "$SANDBOX" | tee "$OUT/chrome-sandbox-mode.txt"

launch_and_check deb "$BIN"

echo "== Removing $PKG"
sudo apt-get remove -y "$PKG"
if [ -e "$BIN" ]; then echo "binary still present after remove"; exit 1; fi

chmod +x "$APPIMAGE"
launch_and_check appimage "$APPIMAGE"
echo "Linux package smoke passed"
