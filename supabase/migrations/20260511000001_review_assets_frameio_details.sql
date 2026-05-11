-- Capture richer Frame.io metadata per file so the review queue can render
-- the real upload date, duration, file size, media type, and comment count
-- instead of falling back to the sync time / placeholders.
--
-- See api/frameio/sync.js for how each column is populated (it reads from
-- the v4 GET /accounts/:acc/files/:id response with `include=media_links.thumbnail`).

ALTER TABLE review_assets ADD COLUMN IF NOT EXISTS frameio_created_at       TIMESTAMPTZ;
ALTER TABLE review_assets ADD COLUMN IF NOT EXISTS frameio_duration_seconds NUMERIC;
ALTER TABLE review_assets ADD COLUMN IF NOT EXISTS frameio_file_size        BIGINT;
ALTER TABLE review_assets ADD COLUMN IF NOT EXISTS frameio_media_type       TEXT;
