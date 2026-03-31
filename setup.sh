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

MAIN_ROOT=""
if [ "$GIT_COMMON" != "$GIT_DIR" ]; then
  MAIN_ROOT=$(cd "$WT_ROOT" && cd "$(git rev-parse --git-common-dir)/.." && pwd)
  echo "  Worktree:  yes (main repo at $MAIN_ROOT)"
else
  echo "  Worktree:  no (main repo)"
fi
echo ""

# 1. Git LFS -- pull binary assets
echo "[1/5] Git LFS..."
if command -v git-lfs &>/dev/null; then
  git lfs install --local >/dev/null 2>&1
  git lfs pull
  echo "  LFS assets pulled."
else
  echo "  Warning: git-lfs not installed. Run 'brew install git-lfs' then re-run setup."
fi
echo ""

# 2. Vercel CLI -- ensure it's available
echo "[2/5] Vercel CLI..."
if command -v vercel &>/dev/null; then
  echo "  Already installed ($(vercel --version 2>/dev/null))."
else
  echo "  Installing globally..."
  npm install -g vercel
  echo "  Installed."
fi
echo ""

# 3. npm install -- Vercel serverless function dependencies
echo "[3/5] npm install..."
if [ -f "$WT_ROOT/package.json" ]; then
  (cd "$WT_ROOT" && npm install --silent)
  echo "  Dependencies installed."
else
  echo "  No package.json found, skipping."
fi
echo ""

# 4. Environment file -- copy from main repo or pull from Vercel
echo "[4/5] Environment (.env)..."
if [ -f "$WT_ROOT/.env" ]; then
  echo "  Already exists."
elif [ -n "$MAIN_ROOT" ] && [ -f "$MAIN_ROOT/.env" ]; then
  cp "$MAIN_ROOT/.env" "$WT_ROOT/.env"
  echo "  Copied from main repo."
else
  # Try pulling from Vercel project
  if command -v vercel &>/dev/null; then
    echo "  Pulling from Vercel..."
    if (cd "$WT_ROOT" && vercel link --project portal --yes >/dev/null 2>&1 && vercel env pull .env --yes >/dev/null 2>&1); then
      echo "  Pulled from Vercel project."
    else
      echo "  Warning: Could not pull from Vercel. Create .env manually."
    fi
  else
    echo "  Warning: No .env found. Create one with required vars:"
    echo "    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY"
  fi
fi
echo ""

# 5. Vercel project link
echo "[5/5] Vercel project link..."
if [ -d "$WT_ROOT/.vercel" ]; then
  echo "  Already linked."
else
  if command -v vercel &>/dev/null; then
    (cd "$WT_ROOT" && vercel link --project portal --yes >/dev/null 2>&1)
    echo "  Linked to portal."
  else
    echo "  Warning: Vercel CLI not available, skipping."
  fi
fi
echo ""

# Verify all required files exist
echo "Checking project files..."
MISSING=0
for f in index.html video.mp4 serve.sh .env; do
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
