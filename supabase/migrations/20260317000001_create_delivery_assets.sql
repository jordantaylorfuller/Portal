-- Delivery assets (synced from Asana tasks with Delivery URL custom field)
CREATE TABLE IF NOT EXISTS delivery_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  asana_task_gid TEXT UNIQUE,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  file_type TEXT,
  file_size TEXT,
  specs TEXT,
  group_name TEXT DEFAULT 'Files',
  status TEXT DEFAULT 'ready',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE delivery_assets ENABLE ROW LEVEL SECURITY;

-- Clients can read deliveries for projects they belong to
CREATE POLICY "Users read project deliveries"
  ON delivery_assets FOR SELECT
  USING (project_id IN (SELECT project_id FROM project_members WHERE user_id = auth.uid()));

CREATE POLICY "Service role full access deliveries"
  ON delivery_assets FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role');
