# Portal -- NIPC Session Review

Static single-page site for New International Picture Company (NIPC), a post-production studio in NYC led by editor Carla Luffe. This page serves as a client session review portal with video playback, transport controls, and Frame.io-style annotation tools.

## Project Structure

```
index.html        -- Single-page app (all HTML/CSS/JS inline)
video.mp4         -- Session video (Git LFS, ~58MB)
images/           -- Logo, favicon, webclip
api/              -- Vercel serverless functions (auth, sessions, deliveries)
lib/              -- Shared backend modules (Supabase client)
backend/          -- Express backend (Docker, not used in Vercel deploy)
vercel.json       -- Vercel config (redirects, headers)
serve.sh          -- Local dev server (Vercel dev, deterministic port)
setup.sh          -- Worktree/dependency bootstrapper
.gitattributes    -- LFS tracking for *.mp4
```

## Tech Stack

- Vanilla HTML/CSS/JS -- no build step, no frameworks
- Google Fonts: DM Mono (300/400/500)
- Git LFS for video assets
- Vercel for hosting and serverless API routes
- Supabase for auth and database
- `vercel dev` for local development (static files + API routes)

## Local Development

```bash
./setup.sh    # Install deps (vercel, npm, lfs), pull env, link project
./serve.sh    # Start Vercel dev server on deterministic port (5200-5999)
```

Port is hash-based from the worktree path so multiple worktrees don't collide.

The `.env` file contains API keys for Supabase, Resend, Asana, and Daily. For new worktrees, `setup.sh` copies it from the main repo or pulls from Vercel.

## Deployment

Push to `main` triggers Vercel production deploy (https://atlanta-beta.vercel.app). Vercel is connected to the GitHub repo with auto-deploy enabled.

Video is served via a Vercel redirect (`vercel.json`) pointing to a GitHub Releases asset (tag `v1.0`).

## Key Features

- **Countdown timer**: 4-second countdown before video plays
- **Full-screen video player**: Session video with custom transport controls
- **Annotation tools**: Frame.io-style drawing/commenting overlay
- **Responsive**: Viewport-aware layout

## Conventions

- All code lives in `index.html` (inline styles and scripts)
- Serverless API routes go in `api/` following Vercel conventions
- Shared backend modules go in `lib/`
- Test changes with `./serve.sh` before committing
- Large binary assets go through Git LFS
