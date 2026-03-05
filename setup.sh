#!/usr/bin/env bash
# ── Portal Worktree Setup ──
# Run this after creating a new git worktree to set up all dependencies.
# Usage: ./setup.sh

set -euo pipefail

echo "── Portal Setup ──"
echo ""

# Detect if we're in a worktree
WT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
IS_WORKTREE=$(git rev-parse --is-inside-work-tree 2>/dev/null || echo "false")
GIT_COMMON=$(cd "$WT_ROOT" && git rev-parse --git-common-dir 2>/dev/null)
GIT_DIR=$(cd "$WT_ROOT" && git rev-parse --git-dir 2>/dev/null)

if [ "$IS_WORKTREE" != "true" ]; then
  echo "Error: Not inside a git repository."
  exit 1
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
echo "  Branch:    $BRANCH"
echo "  Path:      $WT_ROOT"

if [ "$GIT_COMMON" != "$GIT_DIR" ]; then
  MAIN_ROOT=$(cd "$WT_ROOT" && cd "$(git rev-parse --git-common-dir)/.." && pwd)
  echo "  Worktree:  yes (main repo at $MAIN_ROOT)"
else
  echo "  Worktree:  no (main repo)"
fi
echo ""

# 1. Git LFS -- pull binary assets
echo "[1/3] Git LFS..."
if command -v git-lfs &>/dev/null; then
  git lfs install --local >/dev/null 2>&1
  git lfs pull
  echo "  LFS assets pulled."
else
  echo "  Warning: git-lfs not installed. Run 'brew install git-lfs' then re-run setup."
fi
echo ""

# 2. live-server -- ensure it's available globally
echo "[2/3] live-server..."
if command -v live-server &>/dev/null; then
  echo "  Already installed."
else
  echo "  Installing globally..."
  npm install -g live-server
  echo "  Installed."
fi
echo ""

# 3. Verify all required files exist
echo "[3/3] Checking project files..."
MISSING=0
for f in index.html video.mp4 serve.sh; do
  if [ -f "$WT_ROOT/$f" ]; then
    echo "  $f  ok"
  else
    echo "  $f  MISSING"
    MISSING=1
  fi
done

if [ -f "$WT_ROOT/video.mp4" ]; then
  SIZE=$(wc -c < "$WT_ROOT/video.mp4" | tr -d ' ')
  if [ "$SIZE" -lt 1000 ]; then
    echo "  Warning: video.mp4 looks like an LFS pointer ($SIZE bytes). Run 'git lfs pull'."
    MISSING=1
  fi
fi
echo ""

if [ "$MISSING" -eq 1 ]; then
  echo "Setup completed with warnings. Check above."
else
  echo "Setup complete. Run ./serve.sh to start dev server."
fi
