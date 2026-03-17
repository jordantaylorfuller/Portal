#!/usr/bin/env bash
# ── Portal Dev Server ──
# Deterministic port per worktree (hash-based), with branch name in tab title.
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
    # If our own live-server is already on this port, reuse it
    local cmd=$(ps -p $pid -o args= 2>/dev/null || true)
    if echo "$cmd" | grep -q "live-server.*--port=$port"; then
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

# Inject branch name into page title via live-server middleware
MIDDLEWARE_FILE=$(mktemp /tmp/portal-middleware-XXXXXXXX)
mv "$MIDDLEWARE_FILE" "${MIDDLEWARE_FILE}.js"
MIDDLEWARE_FILE="${MIDDLEWARE_FILE}.js"
cat > "$MIDDLEWARE_FILE" << JSEOF
module.exports = function(req, res, next) {
  var originalWrite = res.write;
  var originalEnd = res.end;
  var chunks = [];

  if (req.url === '/' || req.url.endsWith('.html')) {
    res.write = function(chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    };
    res.end = function(chunk) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      var body = Buffer.concat(chunks).toString('utf8');
      body = body.replace(/<title>/, '<title>[$BRANCH :$PORT] ');
      res.setHeader('content-length', Buffer.byteLength(body));
      originalWrite.call(res, body);
      originalEnd.call(res);
    };
  }
  next();
};
JSEOF

# Clean up middleware file on exit
cleanup() { rm -f "$MIDDLEWARE_FILE"; }
trap cleanup EXIT

echo "──────────────────────────────────"
echo "  Branch:  $BRANCH"
echo "  Port:    $PORT"
echo "  URL:     http://localhost:$PORT"
echo "──────────────────────────────────"

live-server --port=$PORT --no-browser --middleware="$MIDDLEWARE_FILE"
