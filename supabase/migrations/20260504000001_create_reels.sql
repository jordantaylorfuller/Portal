-- Reels: curated, branded video presentations shared via public link.

CREATE TABLE IF NOT EXISTS reels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  cover_url TEXT,
  s3_prefix TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  auto_created BOOLEAN NOT NULL DEFAULT FALSE,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reels_status_idx ON reels (status);

CREATE TABLE IF NOT EXISTS reel_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reel_id UUID NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
  s3_key TEXT NOT NULL,
  mux_asset_id TEXT,
  mux_playback_id TEXT,
  title TEXT,
  duration_seconds NUMERIC,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading','encoding','ready','error','archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (reel_id, s3_key)
);

CREATE INDEX IF NOT EXISTS reel_assets_reel_order_idx ON reel_assets (reel_id, sort_order);
CREATE INDEX IF NOT EXISTS reel_assets_mux_asset_idx ON reel_assets (mux_asset_id);

CREATE OR REPLACE FUNCTION reels_touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS reels_touch ON reels;
CREATE TRIGGER reels_touch BEFORE UPDATE ON reels
  FOR EACH ROW EXECUTE FUNCTION reels_touch_updated_at();

DROP TRIGGER IF EXISTS reel_assets_touch ON reel_assets;
CREATE TRIGGER reel_assets_touch BEFORE UPDATE ON reel_assets
  FOR EACH ROW EXECUTE FUNCTION reels_touch_updated_at();

ALTER TABLE reels ENABLE ROW LEVEL SECURITY;
ALTER TABLE reel_assets ENABLE ROW LEVEL SECURITY;

-- Service role gets full access (used by the API via SUPABASE_SERVICE_ROLE_KEY)
CREATE POLICY "Service role full access reels"
  ON reels FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role');

CREATE POLICY "Service role full access reel_assets"
  ON reel_assets FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role');

-- Authenticated admins (user_profiles.role = 'admin') can read/write everything
CREATE POLICY "Admins manage reels"
  ON reels FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY "Admins manage reel_assets"
  ON reel_assets FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'admin'));

-- Public views: only safe columns, only published+ready content. Anon reads via these views.
CREATE OR REPLACE VIEW public_reels_view
  WITH (security_barrier = true) AS
  SELECT id, slug, title, description, cover_url
  FROM reels
  WHERE status = 'published';

CREATE OR REPLACE VIEW public_reel_assets_view
  WITH (security_barrier = true) AS
  SELECT ra.id, ra.reel_id, ra.mux_playback_id, ra.title, ra.sort_order, ra.duration_seconds
  FROM reel_assets ra
  JOIN reels r ON r.id = ra.reel_id
  WHERE r.status = 'published' AND ra.status = 'ready';

GRANT SELECT ON public_reels_view TO anon;
GRANT SELECT ON public_reel_assets_view TO anon;
