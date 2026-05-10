-- Frame.io v4 integration: link portal projects to Frame.io projects, mirror
-- assets, store OAuth refresh tokens for the integration's signed-in user.

-- ---------------------------------------------------------------------------
-- 1. projects: add Frame.io linkage columns.
-- ---------------------------------------------------------------------------
ALTER TABLE projects ADD COLUMN IF NOT EXISTS frameio_account_id      TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS frameio_workspace_id    TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS frameio_project_id      TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS frameio_root_folder_id  TEXT;

CREATE INDEX IF NOT EXISTS projects_frameio_project_id_idx
  ON projects(frameio_project_id);

-- ---------------------------------------------------------------------------
-- 2. review_assets: ensure exists (referenced by api/projects/[id]/reviews.js
--    but missing from migrations dir), then add Frame.io columns.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS review_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  version TEXT,
  status TEXT NOT NULL DEFAULT 'needs_review'
    CHECK (status IN ('needs_review','in_review','approved','archived')),
  video_url TEXT,
  thumb_time NUMERIC DEFAULT 0,
  notes_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE review_assets ADD COLUMN IF NOT EXISTS notes_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE review_assets ADD COLUMN IF NOT EXISTS frameio_asset_id     TEXT;
ALTER TABLE review_assets ADD COLUMN IF NOT EXISTS frameio_share_id     TEXT;
ALTER TABLE review_assets ADD COLUMN IF NOT EXISTS frameio_review_url   TEXT;
ALTER TABLE review_assets ADD COLUMN IF NOT EXISTS frameio_thumb_url    TEXT;
ALTER TABLE review_assets ADD COLUMN IF NOT EXISTS frameio_status_raw   TEXT;
ALTER TABLE review_assets ADD COLUMN IF NOT EXISTS frameio_synced_at    TIMESTAMPTZ;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'review_assets_frameio_asset_id_key'
  ) THEN
    ALTER TABLE review_assets
      ADD CONSTRAINT review_assets_frameio_asset_id_key UNIQUE (frameio_asset_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS review_assets_project_id_idx ON review_assets(project_id);
CREATE INDEX IF NOT EXISTS review_assets_frameio_asset_id_idx
  ON review_assets(frameio_asset_id);

-- Touch updated_at on row update (matches reels migration pattern).
CREATE OR REPLACE FUNCTION review_assets_touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS review_assets_touch ON review_assets;
CREATE TRIGGER review_assets_touch BEFORE UPDATE ON review_assets
  FOR EACH ROW EXECUTE FUNCTION review_assets_touch_updated_at();

-- RLS: service role full access, project members read.
ALTER TABLE review_assets ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname='public' AND tablename='review_assets'
       AND policyname='Service role full access review_assets'
  ) THEN
    CREATE POLICY "Service role full access review_assets"
      ON review_assets FOR ALL
      USING (auth.jwt() ->> 'role' = 'service_role');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname='public' AND tablename='review_assets'
       AND policyname='Members read project review_assets'
  ) THEN
    CREATE POLICY "Members read project review_assets"
      ON review_assets FOR SELECT
      USING (project_id IN (
        SELECT project_id FROM project_members WHERE user_id = auth.uid()
      ));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. frameio_tokens: single-row table holding the integration's refresh token.
--    The Adobe IMS refresh token rotates on every use, so we need persistent
--    mutable storage. Keyed by `name` so we could host multiple integrations
--    later if ever needed; for now there's only "default".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS frameio_tokens (
  name             TEXT PRIMARY KEY,
  refresh_token    TEXT NOT NULL,
  access_token     TEXT,
  access_expires_at TIMESTAMPTZ,
  account_id       TEXT,
  user_email       TEXT,
  scopes           TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE frameio_tokens ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname='public' AND tablename='frameio_tokens'
       AND policyname='Service role only frameio_tokens'
  ) THEN
    CREATE POLICY "Service role only frameio_tokens"
      ON frameio_tokens FOR ALL
      USING (auth.jwt() ->> 'role' = 'service_role');
  END IF;
END $$;
