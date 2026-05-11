-- Per-asset poster crop transform. Lets the admin position and scale the chosen
-- poster source (Mux frame OR uploaded image) inside the 16:9 delivery frame,
-- since the source media spans many aspect ratios (4:3, 5:4, vertical, etc.).

ALTER TABLE reel_assets ADD COLUMN IF NOT EXISTS poster_focal_x NUMERIC NOT NULL DEFAULT 50;
ALTER TABLE reel_assets ADD COLUMN IF NOT EXISTS poster_focal_y NUMERIC NOT NULL DEFAULT 50;
ALTER TABLE reel_assets ADD COLUMN IF NOT EXISTS poster_zoom NUMERIC NOT NULL DEFAULT 1.0;

ALTER TABLE reel_assets
  ADD CONSTRAINT reel_assets_poster_focal_x_range CHECK (poster_focal_x BETWEEN 0 AND 100),
  ADD CONSTRAINT reel_assets_poster_focal_y_range CHECK (poster_focal_y BETWEEN 0 AND 100),
  ADD CONSTRAINT reel_assets_poster_zoom_range    CHECK (poster_zoom    BETWEEN 1 AND 4);

CREATE OR REPLACE VIEW public_reel_assets_view
  WITH (security_barrier = true) AS
  SELECT
    ra.id, ra.reel_id, ra.mux_playback_id, ra.title, ra.sort_order, ra.duration_seconds,
    ra.poster_url, ra.poster_time,
    ra.poster_focal_x, ra.poster_focal_y, ra.poster_zoom
  FROM reel_assets ra
  JOIN reels r ON r.id = ra.reel_id
  WHERE r.status = 'published' AND ra.status = 'ready';

GRANT SELECT ON public_reel_assets_view TO anon;
