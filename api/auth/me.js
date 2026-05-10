const { getAuthUser } = require('../../lib/auth');
const { adminClient } = require('../../lib/supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await getAuthUser(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const { data: profile } = await adminClient
    .from('user_profiles')
    .select('display_name, initials, role')
    .eq('id', auth.id)
    .single();

  const { data: memberships } = await adminClient
    .from('project_members')
    .select('project_id, role, projects(id, name, status)')
    .eq('user_id', auth.id);

  const projects = (memberships || [])
    .filter(m => m.projects && m.projects.status !== 'archived')
    .map(m => ({
      id: m.projects.id,
      name: m.projects.name,
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
