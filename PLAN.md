# NIPC Client Portal -- Project Plan

## Current State (SESSIONS branch, uncommitted)

### Done
- [x] Download buttons on review queue (right of status indicator)
- [x] Archive status option + expandable archive section with twist-open animation
- [x] Cascade entrance animations (80ms stagger per row)
- [x] Dropdown z-index/opacity fixes (fully opaque, no bleed-through)
- [x] Backend scaffolding: Express server, health check, CORS
- [x] Auth routes: magic link (via Resend), verify OTP, /me, profile save
- [x] Asana webhook handler: handshake, HMAC verification, client onboarding (auto-creates Supabase user + sends magic link when "Client Email" custom field set)
- [x] Session booking routes: book, list, cancel (weekday-only, dedup)
- [x] Supabase schema deployed: user_profiles, projects, project_members + RLS policies
- [x] 4 seed projects: Portal, Buffalo (active), Sweetgreen, Glossier (archived)
- [x] Frontend auth: invite-only magic link flow, session persistence, auth guards on review/mux pages
- [x] Dynamic project switcher from API
- [x] Supabase CLI linked (project ref: qnaqxnrbsvushgfwnjnd)
- [x] Delivery room: dynamic from Supabase via API, scrollable file list, pinned upload button
- [x] Delivery webhook: Asana "Delivery URL" custom field --> auto-sync to delivery_assets table
- [x] Supabase migration: delivery_assets table with RLS policies

### Credentials Secured
- [x] Supabase URL, anon key, service role key (in backend/.env, gitignored)
- [x] Asana PAT (in backend/.env)
- [x] GCP Project ID (nipc-portal)
- [ ] Dolby.io / Millicast -- pending demo approval
- [ ] Backblaze B2 -- not yet provisioned
- [ ] Iconik -- not yet provisioned

---

## Architecture

```
ASANA (source of truth)
  |-- Producer manages projects, adds client emails, pastes delivery links
  v
CLOUD RUN (primary backend)
  |-- POST /webhooks/asana      --> user creation, magic links, delivery sync
  |-- GET  /api/projects/:id    --> portal data (cached)
  |-- GET  /api/download/:key   --> presigned URL generation
  |-- POST /api/sessions        --> Dolby.io stream token creation
  |
B2/S3 BUCKET (asset storage)
  |-- Video lands in project folder
  v
CLOUD RUN (triggered by Eventarc/EventBridge)
  |-- Notifies Iconik to index new asset
  |-- Creates review link via Iconik API
  |-- Publishes to portal + Asana
  |
CLIENT PORTAL (static frontend + Supabase auth)
  |-- Login: invite-only magic link
  |-- Delivery Room: presigned download URLs or external delivery links
  |-- Review Room: Iconik review links + approval status
  |-- Session Room: Dolby.io hero stream + talkback (dual-token)
```

---

## Phase 1: Delivery Room (CURRENT PRIORITY)

### Goal
Producers can paste a delivery link (Suite.io, Iconik, Frame.io, or direct URL) into Asana and clients see it instantly in the portal delivery room.

### Workflow Design
**Producer side (Asana-native, zero new tools):**
1. Producer creates deliverable on Suite.io / Iconik / Frame.io / B2
2. Producer opens Asana project, creates or updates a task in "Deliveries" section
3. Pastes the download link into a "Delivery URL" custom field
4. Optionally sets file metadata (name, codec, size) in task name/description
5. Webhook fires --> backend syncs to Supabase --> portal updates instantly

**Client side (portal):**
1. Client opens delivery room
2. Sees list of deliverables pulled from Supabase (not hardcoded)
3. Clicks download --> redirected to external link or presigned URL

### Tasks
- [x] Add `delivery_assets` table to Supabase (project_id, title, url, file_type, file_size, specs, group_name, status)
- [x] Add "Delivery URL" custom field detection to Asana webhook handler
- [x] Create GET /api/projects/:id/deliveries endpoint (auth-gated, grouped response)
- [x] Replace hardcoded delivery room HTML with dynamic container (#delivery-groups)
- [x] Wire download buttons to real URLs (opens external links in new tab)
- [x] Fixed-height delivery layout: scrollable file list, pinned upload button at bottom
- [x] Seed data: 6 test deliveries across Finals, Alternate Cuts, Audio groups
- [ ] Add real-time updates (Supabase Realtime or polling)
- [x] Test full authenticated flow (login --> project select --> delivery room loads from API)

### Future: Native B2/S3 Integration
When B2 is provisioned, the delivery room can also generate presigned download URLs for files stored directly in the bucket, bypassing external platforms entirely. The Asana workflow stays the same -- producer pastes an S3/B2 path instead of an external URL, and the backend generates a time-limited download link.

---

## Phase 2: Calendar + Google Calendar Integration

### Goal
When a client books a session, automatically send a Google Calendar invite to the client and all project leads (pulled from Asana).

### Workflow Design
**Booking flow:**
1. Client selects date/time/project in scheduler UI --> POST /api/sessions/book
2. Backend saves to Supabase `sessions` table (already done)
3. Backend queries Asana for project leads (members/owners of the linked Asana project)
4. Backend creates a Google Calendar event with attendees: client + all project leads
5. Everyone gets a calendar invite

**Asana as source of truth for project leads:**
- Each portal project has an `asana_project_id`
- Project leads are identified by Asana project membership (owners/members)
- When a session is booked, backend fetches project members from Asana API

### Prerequisites
- [ ] Google Cloud service account with Calendar API enabled
- [ ] Service account JSON key stored in backend/.env
- [ ] Determine which Google Calendar to create events on (shared studio calendar or per-project)
- [ ] Define how project leads are identified in Asana (project members, custom field, or task assignees)

### Tasks
- [ ] Add `googleapis` package to backend
- [ ] Create Google Calendar service (backend/src/services/google-calendar.js)
- [ ] Create Asana project leads lookup (backend/src/services/asana.js)
- [ ] Wire into POST /api/sessions/book: after Supabase insert, fetch leads, create calendar event
- [ ] Store Google Calendar event ID in `sessions` table for updates/cancellation
- [ ] On DELETE /api/sessions/:id, cancel the corresponding Google Calendar event
- [ ] Add `sessions` table migration: `gcal_event_id` column
- [ ] Test full flow: book session --> calendar invite received by client + leads
- [ ] Handle edge cases: no project leads found, calendar API failure (session still saved)

---

## Phase 3: Review Room Wiring (was Phase 2)

### Goal
Replace hardcoded review queue with real assets from Iconik (or Frame.io as fallback).

### Tasks
- [ ] Add `review_assets` table to Supabase
- [ ] Integrate Iconik API: register B2 bucket, index assets, generate review links
- [ ] Create GET /api/projects/:id/reviews endpoint
- [ ] Wire review-queue.html to pull from API instead of mock data
- [ ] Status changes sync back to Iconik + Asana
- [ ] Frame.io fallback integration (if Iconik not yet provisioned)

---

## Phase 4: Session Room Wiring (was Phase 3)

### Goal
Automated live edit session creation via Dolby.io/Millicast with hero stream + talkback.

### Tasks
- [ ] Dolby.io account activation (pending demo)
- [ ] POST /api/sessions/:id/join --> dual-token endpoint (subscribe token + comms token)
- [ ] Build viewer UI: hero program feed (iframe or Web SDK) + webcam tiles + talkback
- [ ] Session lifecycle: auto-create stream when Asana task moves to "In Session"
- [ ] Webhooks: stream start/stop, viewer connect/disconnect

---

## Phase 5: Cloud Run Deployment (was Phase 4)

### Tasks
- [ ] Finalize Dockerfile (currently a stub)
- [ ] Set up GCP Secret Manager for all credentials
- [ ] Deploy to Cloud Run with min-instances=1
- [ ] Configure custom domain
- [ ] Set up Eventarc triggers for B2/S3 events
- [ ] CI/CD: GitHub Actions --> Cloud Run on push to main

---

## Phase 6: Full Automation Loop (was Phase 5)

### Tasks
- [ ] Asana --> Supabase user sync (auto-invite on custom field change) -- DONE, needs testing
- [ ] B2 upload watcher --> Iconik ingestion --> review link published to portal
- [ ] Frame.io webhook --> approval status synced to Asana + portal
- [ ] Session recording archival
- [ ] Email notifications (Resend) for new deliveries, review requests, session invites

---

## Tech Stack

| Layer | Technology | Status |
|-------|-----------|--------|
| Frontend | Vanilla HTML/CSS/JS (inline) | Active |
| Auth | Supabase (magic links) | Wired |
| Database | Supabase (Postgres + RLS) | Deployed |
| Backend | Node.js + Express | Running locally |
| Project Mgmt | Asana (source of truth) | Webhook handler built |
| Object Storage | Backblaze B2 (S3-compatible) | Not provisioned |
| Review Platform | Iconik (BYOS) | Not provisioned |
| Review Fallback | Frame.io | Planned |
| Live Sessions | Dolby.io / Millicast | Pending demo |
| Calendar | Google Calendar API | Phase 2 (next) |
| Email | Resend | Wired |
| Hosting (backend) | Google Cloud Run | Dockerfile exists |
| Hosting (frontend) | GitHub Pages | Active (deploy workflow exists) |
