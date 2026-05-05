-- Custom poster (uploaded image) and / or Mux-frame timestamp per asset.

ALTER TABLE reel_assets ADD COLUMN IF NOT EXISTS poster_url TEXT;
ALTER TABLE reel_assets ADD COLUMN IF NOT EXISTS poster_time NUMERIC;

-- Public view exposes poster_url (Storj key) and poster_time so the API can resolve them.
-- The view itself stays anon-readable; the API resolves the key into a presigned URL.
CREATE OR REPLACE VIEW public_reel_assets_view
  WITH (security_barrier = true) AS
  SELECT
    ra.id, ra.reel_id, ra.mux_playback_id, ra.title, ra.sort_order, ra.duration_seconds,
    ra.poster_url, ra.poster_time
  FROM reel_assets ra
  JOIN reels r ON r.id = ra.reel_id
  WHERE r.status = 'published' AND ra.status = 'ready';

GRANT SELECT ON public_reel_assets_view TO anon;
