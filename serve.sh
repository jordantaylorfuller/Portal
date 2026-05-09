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
echo "──────────────────────────────────"

npx vercel dev --listen $PORT
