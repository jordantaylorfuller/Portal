-- Extend delivery_assets to support client-to-studio uploads via MASV.
-- direction='studio_to_client' for the existing Asana-driven flow,
-- direction='client_to_studio' for MASV Portal uploads.

ALTER TABLE delivery_assets
  ADD COLUMN IF NOT EXISTS masv_package_id TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS uploader_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'studio_to_client';

CREATE INDEX IF NOT EXISTS delivery_assets_masv_package_id_idx
  ON delivery_assets (masv_package_id);
