const { getAuthUser } = require('../../../lib/auth');
const { adminClient } = require('../../../lib/supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await getAuthUser(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const { projectId } = req.query;

  const { data: membership } = await adminClient
    .from('project_members')
    .select('role')
    .eq('project_id', projectId)
    .eq('user_id', auth.id)
    .single();

  if (!membership) {
    return res.status(403).json({ error: 'No access to this project' });
  }

  const { data: assets, error } = await adminClient
    .from('delivery_assets')
    .select('id, title, url, file_type, file_size, specs, group_name, status, created_at')
    .eq('project_id', projectId)
    .order('group_name')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Deliveries fetch error:', error.message);
    return res.status(500).json({ error: 'Failed to fetch deliveries' });
  }

  const groups = {};
  for (const asset of (assets || [])) {
    const g = asset.group_name || 'Files';
    if (!groups[g]) groups[g] = [];
    groups[g].push(asset);
  }

  res.json({
    project_id: projectId,
    groups,
    total: (assets || []).length
  });
};
