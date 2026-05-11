const { adminClient } = require('./supabase');
const { isAdmin: isAdminUser } = require('./admin');

async function getAuthUser(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return null;
  }
  const token = auth.replace('Bearer ', '');
  const { data: { user }, error } = await adminClient.auth.getUser(token);
  if (error || !user) return null;
  return {
    id: user.id,
    email: user.email,
    metadata: user.user_metadata,
    token
  };
}

// Gate per-project routes. Admins reach every project; clients must be members
// AND the project must be visible. Replies 401/403/404 directly on failure;
// returns { auth, isAdmin, role } on success, or null when a response was sent.
async function requireProjectAccess(req, res, projectId) {
  const auth = await getAuthUser(req);
  if (!auth) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  if (!projectId) {
    res.status(400).json({ error: 'projectId required' });
    return null;
  }

  const [profileResult, projectResult, membershipResult] = await Promise.all([
    adminClient.from('user_profiles').select('role').eq('id', auth.id).maybeSingle(),
    adminClient.from('projects').select('id, status, is_visible_to_clients').eq('id', projectId).maybeSingle(),
    adminClient.from('project_members').select('role').eq('project_id', projectId).eq('user_id', auth.id).maybeSingle()
  ]);

  const isAdmin = isAdminUser(profileResult.data, auth.email);
  const project = projectResult.data;
  const membership = membershipResult.data;

  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return null;
  }

  if (isAdmin) {
    return { auth, isAdmin: true, role: membership ? membership.role : 'admin', project };
  }

  if (!membership) {
    res.status(403).json({ error: 'No access to this project' });
    return null;
  }

  if (!project.is_visible_to_clients || project.status === 'archived') {
    res.status(403).json({ error: 'No access to this project' });
    return null;
  }

  return { auth, isAdmin: false, role: membership.role, project };
}

module.exports = { getAuthUser, requireProjectAccess };
