const { getAuthUser } = require('../../lib/auth');
const { adminClient, createClientForUser } = require('../../lib/supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await getAuthUser(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const { data: profile } = await adminClient
    .from('user_profiles')
    .select('display_name, initials, role')
    .eq('id', auth.id)
    .single();

  // Use a user-scoped client for the projects join so RLS filters out
  // Internal projects for non-admins. The "Admins read all projects" and
  // "Members read visible projects" policies (Phase 1 migration) are the
  // single source of truth for visibility — service-role queries bypass them.
  const userClient = createClientForUser(auth.token);
  const { data: memberships } = await userClient
    .from('project_members')
    .select('project_id, role, projects(id, name, display_name, status)')
    .eq('user_id', auth.id);

  const projects = (memberships || [])
    .filter(m => m.projects && m.projects.status !== 'archived')
    .map(m => ({
      id: m.projects.id,
      name: m.projects.display_name || m.projects.name,
      status: m.projects.status,
      role: m.role
    }));

  const needsProfile = !profile;

  res.json({
    email: auth.email,
    displayName: profile ? profile.display_name : auth.email.split('@')[0],
    initials: profile ? profile.initials : auth.email.slice(0, 2).toUpperCase(),
    role: profile ? profile.role : 'client',
    needsProfile,
    projects
  });
};
