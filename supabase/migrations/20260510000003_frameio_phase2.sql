-- Phase 2: per-project admin controls + client invitations.
--   - display_name: admin-overridable label that beats projects.name in UI.
--                   Sync owns `name` (always Frame.io's stripped name);
--                   admin owns `display_name`. UI reads display_name ?? name.
--   - members_count: cached count used by the admin list to avoid N+1.
--                    Maintained by trigger on project_members insert/delete.
--   - project_members.added_at: needed by the members list UI.

-- ---------------------------------------------------------------------------
-- 1. projects: admin-overridable name + cached count.
-- ---------------------------------------------------------------------------
ALTER TABLE projects ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS members_count INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 2. project_members: track when each membership was created.
-- ---------------------------------------------------------------------------
ALTER TABLE project_members
  ADD COLUMN IF NOT EXISTS added_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- ---------------------------------------------------------------------------
-- 3. Trigger to keep projects.members_count in sync.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION refresh_project_members_count()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE projects SET members_count = members_count + 1 WHERE id = NEW.project_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE projects SET members_count = GREATEST(members_count - 1, 0) WHERE id = OLD.project_id;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS project_members_count_trigger ON project_members;
CREATE TRIGGER project_members_count_trigger
  AFTER INSERT OR DELETE ON project_members
  FOR EACH ROW EXECUTE FUNCTION refresh_project_members_count();

-- ---------------------------------------------------------------------------
-- 4. Backfill existing counts (idempotent — sets to authoritative value).
-- ---------------------------------------------------------------------------
UPDATE projects p SET members_count = (
  SELECT count(*)::int FROM project_members WHERE project_id = p.id
);
