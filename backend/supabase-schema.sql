-- NIPC Portal Schema
-- Run this in Supabase Dashboard > SQL Editor

-- User profiles linked to auth.users
CREATE TABLE IF NOT EXISTS user_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  initials TEXT NOT NULL,
  role TEXT DEFAULT 'client',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Projects (synced from Asana)
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asana_project_id TEXT UNIQUE,
  name TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Project membership (who can access what)
CREATE TABLE IF NOT EXISTS project_members (
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT DEFAULT 'viewer',
  PRIMARY KEY (project_id, user_id)
);

-- Session bookings
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  session_date DATE NOT NULL,
  session_time TEXT NOT NULL,
  status TEXT DEFAULT 'confirmed',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Enable Row Level Security
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users read own profile"
  ON user_profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Users read their projects"
  ON projects FOR SELECT
  USING (id IN (SELECT project_id FROM project_members WHERE user_id = auth.uid()));

CREATE POLICY "Users read own memberships"
  ON project_members FOR SELECT
  USING (user_id = auth.uid());

-- Service role needs full access for webhook-driven writes
CREATE POLICY "Service role full access profiles"
  ON user_profiles FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role');

CREATE POLICY "Service role full access projects"
  ON projects FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role');

CREATE POLICY "Service role full access members"
  ON project_members FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role');

-- Sessions: users can read their own bookings
CREATE POLICY "Users read own sessions"
  ON sessions FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Service role full access sessions"
  ON sessions FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role');

-- Delivery assets:
--   direction='studio_to_client' rows are synced from Asana tasks with a Delivery URL custom field.
--   direction='client_to_studio' rows are written by the MASV webhook on package.finalized.
CREATE TABLE IF NOT EXISTS delivery_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  asana_task_gid TEXT UNIQUE,
  masv_package_id TEXT UNIQUE,
  uploader_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  direction TEXT NOT NULL DEFAULT 'studio_to_client',
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
