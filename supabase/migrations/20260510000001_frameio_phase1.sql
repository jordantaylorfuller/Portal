-- Phase 1: Frame.io is the source of truth for projects.
-- Adds visibility + provenance columns. Tightens RLS so non-admin members
-- only see projects that have been explicitly published. Archives the
-- four legacy test rows.

-- ---------------------------------------------------------------------------
-- 1. New columns on projects.
-- ---------------------------------------------------------------------------
ALTER TABLE projects ADD COLUMN IF NOT EXISTS is_visible_to_clients BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS frameio_project_name  TEXT;        -- original "#NNNN_NAME" from Frame.io
ALTER TABLE projects ADD COLUMN IF NOT EXISTS frameio_archived_at   TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- 2. Replace SELECT policy. Old "Users read their projects" allowed any
--    membership; new model requires admin role OR (visible AND member).
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users read their projects" ON projects;
DROP POLICY IF EXISTS "Admins read all projects"   ON projects;
DROP POLICY IF EXISTS "Members read visible projects" ON projects;

CREATE POLICY "Admins read all projects"
  ON projects FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM user_profiles
    WHERE id = auth.uid() AND role = 'admin'
  ));

CREATE POLICY "Members read visible projects"
  ON projects FOR SELECT
  USING (
    is_visible_to_clients = true
    AND id IN (SELECT project_id FROM project_members WHERE user_id = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- 3. Archive the four legacy test rows so the new admin UI shows them as
--    archived instead of active. Idempotent: only flips active rows.
-- ---------------------------------------------------------------------------
UPDATE projects
SET status = 'archived',
    is_visible_to_clients = false
WHERE id IN (
  '5913a82c-a4af-40e4-8e5d-df8e7a2c0361', -- Buffalo
  '4d9dca57-2330-4ee8-9dae-8409b681723d', -- Glossier
  'd3e1d805-ec33-4a8b-bdc4-106d8aba6be0', -- Portal
  'e4d5cc53-c8b4-45a5-8700-6198c47bf852'  -- Sweetgreen
);
