#!/usr/bin/env bash
# ── Portal Dev Server ──
# Deterministic port per worktree (hash-based), using Vercel dev
# so API routes work locally.
# Usage: ./serve.sh

set -euo pipefail

PORT_MIN=5200
PORT_MAX=5999
PORT_RANGE=$((PORT_MAX - PORT_MIN))

# Get branch name and worktree path
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
WT_PATH=$(pwd)

# Hash the worktree path to a deterministic port
HASH=$(echo -n "$WT_PATH" | shasum | cut -c1-8)
HASH_DEC=$((16#$HASH))
PORT=$((PORT_MIN + (HASH_DEC % PORT_RANGE)))

# Find an available port, starting with the deterministic one
find_port() {
  local port=$1
  local attempts=0
  while [ $attempts -lt $PORT_RANGE ]; do
    local pid=$(lsof -ti:$port 2>/dev/null || true)
    if [ -z "$pid" ]; then
      echo $port
      return 0
    fi
    # If our own vercel dev is already on this port, reuse it
    local cmd=$(ps -p $pid -o args= 2>/dev/null || true)
    if echo "$cmd" | grep -q "vercel dev.*--listen $port"; then
      echo "already:$port:$pid"
      return 0
    fi
    port=$(( PORT_MIN + ((port - PORT_MIN + 1) % PORT_RANGE) ))
    attempts=$((attempts + 1))
  done
  echo ""
  return 1
}

# Start the file watcher in the background for THIS worktree on THIS run's
# port + 100. If a watcher from a previous run is still around (possibly on
# a stale port), kill it first — the browser computes the SSE URL from its
# current page port, so the watcher must always be on (vercel port) + 100.
# Pass --no-watch to skip. WATCH_SKIP_INITIAL=1 makes the watcher skip its
# initial build, since vercel dev runs `npm run build` on startup and we
# don't want them racing on the same output files.
ensure_watcher() {
  if [ "${1:-}" = "--no-watch" ]; then return 0; fi
  local watch_port=$((PORT + 100))
  # Kill any existing watcher for this worktree (match by argv containing
  # the worktree path so we don't touch other workspaces' watchers).
  for pid in $(pgrep -f "scripts/watch-cms.mjs" 2>/dev/null); do
    if ps -o args= -p "$pid" 2>/dev/null | grep -q "$WT_PATH"; then
      kill "$pid" 2>/dev/null && echo "  Replaced stale watcher PID $pid"
    fi
  done
  # Wait briefly for old watcher's port to free up.
  for i in 1 2 3 4 5; do
    if ! lsof -ti:$watch_port >/dev/null 2>&1; then break; fi
    sleep 0.2
  done
  WATCH_SKIP_INITIAL=1 WATCH_PORT=$watch_port node "$WT_PATH/scripts/watch-cms.mjs" >>/tmp/watch-cms-$PORT.log 2>&1 &
  WATCHER_PID=$!
  disown $WATCHER_PID 2>/dev/null || true
  echo "  Watcher: PID $WATCHER_PID (SSE reload on :$watch_port)"
  echo "  Watch log: /tmp/watch-cms-$PORT.log"
}

RESULT=$(find_port $PORT)
if [ -z "$RESULT" ]; then
  echo "No available port in range $PORT_MIN-$PORT_MAX"
  exit 1
elif [[ "$RESULT" == already:* ]]; then
  PORT=${RESULT#already:}
  PORT=${PORT%%:*}
  EXISTING_PID=${RESULT##*:}
  echo "──────────────────────────────────"
  echo "  Already running (PID $EXISTING_PID)"
  echo "  Branch:  $BRANCH"
  echo "  Port:    $PORT"
  echo "  URL:     http://localhost:$PORT"
  ensure_watcher "${1:-}"
  echo "──────────────────────────────────"
  exit 0
else
  PORT=$RESULT
fi

if [ ! -f "$WT_PATH/.vercel/project.json" ]; then
  echo "Workspace is not linked to Vercel. Run ./setup.sh first."
  exit 1
fi

echo "──────────────────────────────────"
echo "  Branch:  $BRANCH"
echo "  Port:    $PORT"
echo "  URL:     http://localhost:$PORT"
ensure_watcher "${1:-}"
echo "──────────────────────────────────"

npx vercel dev --listen $PORT
