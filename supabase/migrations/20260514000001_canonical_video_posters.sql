-- Canonical poster per Mux video.
--
-- Until now the poster (URL / time / focal-point / zoom) lived on each
-- reel_assets row, so the same Mux video added to two reels could carry two
-- independent posters. The admin tool only edits one row at a time, which
-- meant a single "change the poster of EXPEDIA Lemons" action had to be
-- repeated per surface.
--
-- This migration introduces `video_posters`, keyed by mux_playback_id, as the
-- single source of truth. The reel_assets.poster_* columns stay in place for
-- now as a soft fallback (and to avoid breaking older API code mid-deploy),
-- but the view below reads exclusively from video_posters with sane defaults.

CREATE TABLE IF NOT EXISTS video_posters (
  mux_playback_id TEXT PRIMARY KEY,
  poster_url      TEXT,
  poster_time     NUMERIC,
  poster_focal_x  NUMERIC NOT NULL DEFAULT 50,
  poster_focal_y  NUMERIC NOT NULL DEFAULT 50,
  poster_zoom     NUMERIC NOT NULL DEFAULT 1,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT video_posters_focal_x_range CHECK (poster_focal_x BETWEEN 0 AND 100),
  CONSTRAINT video_posters_focal_y_range CHECK (poster_focal_y BETWEEN 0 AND 100),
  CONSTRAINT video_posters_zoom_range    CHECK (poster_zoom    BETWEEN 1 AND 4)
);

-- Backfill: collapse per-asset poster settings into one row per playback id.
-- Where multiple reel_assets reference the same playback id, the most recently
-- updated row wins. Rows with no playback id (still encoding, errored) are
-- skipped — they'll get a record the moment they pick up a playback id and
-- the admin tool writes to it.
INSERT INTO video_posters (
  mux_playback_id, poster_url, poster_time,
  poster_focal_x, poster_focal_y, poster_zoom, updated_at
)
SELECT DISTINCT ON (mux_playback_id)
  mux_playback_id, poster_url, poster_time,
  COALESCE(poster_focal_x, 50),
  COALESCE(poster_focal_y, 50),
  COALESCE(poster_zoom,    1),
  COALESCE(updated_at, now())
FROM reel_assets
WHERE mux_playback_id IS NOT NULL
ORDER BY mux_playback_id, updated_at DESC NULLS LAST
ON CONFLICT (mux_playback_id) DO NOTHING;

-- Public view now joins on video_posters. LEFT JOIN + defaults so a video
-- without an explicit poster record still produces a usable row (untransformed
-- default Mux thumbnail, served via the API's resolvePoster fallback).
CREATE OR REPLACE VIEW public_reel_assets_view
  WITH (security_barrier = true) AS
  SELECT
    ra.id, ra.reel_id, ra.mux_playback_id, ra.title, ra.sort_order, ra.duration_seconds,
    vp.poster_url, vp.poster_time,
    COALESCE(vp.poster_focal_x, 50) AS poster_focal_x,
    COALESCE(vp.poster_focal_y, 50) AS poster_focal_y,
    COALESCE(vp.poster_zoom,    1)  AS poster_zoom
  FROM reel_assets ra
  JOIN reels r ON r.id = ra.reel_id
  LEFT JOIN video_posters vp ON vp.mux_playback_id = ra.mux_playback_id
  WHERE r.status = 'published' AND ra.status = 'ready';

GRANT SELECT ON public_reel_assets_view TO anon;

-- Touch helper for updated_at on writes.
CREATE OR REPLACE FUNCTION video_posters_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS video_posters_touch ON video_posters;
CREATE TRIGGER video_posters_touch
  BEFORE UPDATE ON video_posters
  FOR EACH ROW EXECUTE FUNCTION video_posters_touch_updated_at();
