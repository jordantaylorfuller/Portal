-- Track when each member last viewed a project's Review and Delivery rooms.
-- Used to drive the unread-count badges on the rooms dashboard.
-- Null = never viewed; all current items count as "new" for that user.

ALTER TABLE project_members
  ADD COLUMN IF NOT EXISTS review_seen_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivery_seen_at TIMESTAMPTZ;
