# Portal -- NIPC Session Review

Static single-page site for New International Picture Company (NIPC), a post-production studio in NYC led by editor Carla Luffe. This page serves as a client session review portal with video playback, transport controls, and Frame.io-style annotation tools.

## Project Structure

```
index.html        -- Single-page app (all HTML/CSS/JS inline)
video.mp4         -- Session video (Git LFS, ~58MB)
images/           -- Logo, favicon, webclip
serve.sh          -- Local dev server (deterministic port per worktree)
setup.sh          -- Worktree/dependency bootstrapper
.gitattributes    -- LFS tracking for *.mp4
.github/workflows/deploy.yml -- GitHub Pages deployment
```

## Tech Stack

- Vanilla HTML/CSS/JS -- no build step, no frameworks
- Google Fonts: DM Mono (300/400/500)
- Git LFS for video assets
- live-server for local development
- GitHub Pages for hosting (video served from GitHub Releases)

## Local Development

```bash
./setup.sh    # Install deps (git-lfs, live-server), pull LFS assets
./serve.sh    # Start dev server on deterministic port (5200-5999)
```

Port is hash-based from the worktree path so multiple worktrees don't collide.

## Deployment

Push to `main` triggers GitHub Pages deploy. The deploy workflow:
1. Rewrites `video.mp4` src to a GitHub Releases URL
2. Removes the LFS video file from the deploy artifact
3. Uploads remaining files to GitHub Pages

Video must be uploaded as a GitHub Release asset (tag `v1.0`).

## Key Features

- **Countdown timer**: 4-second countdown before video plays
- **Full-screen video player**: Session video with custom transport controls
- **Annotation tools**: Frame.io-style drawing/commenting overlay
- **Responsive**: Viewport-aware layout

## Conventions

- All code lives in `index.html` (inline styles and scripts)
- No package.json or node_modules -- keep it zero-dependency
- Test changes with `./serve.sh` before committing
- Large binary assets go through Git LFS

## Known issue: Vercel env vars with trailing newline

When adding/updating a Vercel env var, never pipe a value that ends with a newline. `echo "value"` and copy-paste with a trailing return both store the newline as a real character, which then serializes to a literal `\n` inside the value (e.g. `https://example.com\n`). The local dotenv parser strips it, so dev works; the function runtime keeps it, so prod requests 404 with a "trailing junk" URL.

Confirmed casualties so far: `BREVO_FORM_URL` (newsletter 502), `SUPABASE_URL` (silently malformed — supabase-js normalized it).

When (re)setting an env var:

```bash
printf '%s' 'value-with-no-trailing-newline' | vercel env add NAME production
```

Verify with `vercel env pull /tmp/check.env --environment production --yes` and confirm the value ends at the expected character (not `\n"`).
