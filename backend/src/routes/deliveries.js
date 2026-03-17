const { Router } = require('express');
const { adminClient } = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');

const router = Router();

// GET /api/projects/:projectId/deliveries
// Return delivery assets for a project the user has access to
router.get('/:projectId/deliveries', requireAuth, async (req, res) => {
  const { projectId } = req.params;

  // Verify user has access to this project
  const { data: membership } = await adminClient
    .from('project_members')
    .select('role')
    .eq('project_id', projectId)
    .eq('user_id', req.user.id)
    .single();

  if (!membership) {
    return res.status(403).json({ error: 'No access to this project' });
  }

  // Fetch delivery assets ordered by group then creation date
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

  // Group by group_name for the frontend
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
});

module.exports = router;
