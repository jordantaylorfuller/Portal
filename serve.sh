#!/usr/bin/env bash
# ── Portal Dev Server ──
# Runs Vercel dev server with deterministic port per worktree (hash-based).
# Serves both static files and serverless API routes.
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
    # If vercel dev is already on this port, reuse it
    local cmd=$(ps -p $pid -o args= 2>/dev/null || true)
    if echo "$cmd" | grep -q "vercel.*dev.*--listen.*$port"; then
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

# Pre-flight checks
if ! command -v vercel &>/dev/null; then
  echo "Error: Vercel CLI not installed. Run ./setup.sh first."
  exit 1
fi

if [ ! -f .env ]; then
  echo "Warning: No .env file. API routes will fail. Run ./setup.sh first."
fi

if [ ! -d .vercel ]; then
  echo "Linking Vercel project..."
  vercel link --project portal --yes >/dev/null 2>&1
fi

echo "──────────────────────────────────"
echo "  Branch:  $BRANCH"
echo "  Port:    $PORT"
echo "  URL:     http://localhost:$PORT"
echo "──────────────────────────────────"

vercel dev --listen $PORT --yes 2>&1
