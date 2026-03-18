const { getAuthUser } = require('../../../lib/auth');
const { adminClient } = require('../../../lib/supabase');

module.exports = async function handler(req, res) {
  const auth = await getAuthUser(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const { projectId } = req.query;

  // Verify project membership
  const { data: membership } = await adminClient
    .from('project_members')
    .select('role')
    .eq('project_id', projectId)
    .eq('user_id', auth.id)
    .single();

  if (!membership) {
    return res.status(403).json({ error: 'No access to this project' });
  }

  if (req.method === 'GET') {
    const { data: assets, error } = await adminClient
      .from('review_assets')
      .select('id, title, version, status, video_url, thumb_time, created_at, updated_at')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Reviews fetch error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch reviews' });
    }

    // Get comment counts per asset
    const assetIds = (assets || []).map(function(a) { return a.id; });
    var commentCounts = {};
    if (assetIds.length > 0) {
      const { data: counts } = await adminClient
        .rpc('get_review_comment_counts', { asset_ids: assetIds });

      if (counts) {
        counts.forEach(function(c) { commentCounts[c.asset_id] = parseInt(c.count, 10); });
      }
    }

    var result = (assets || []).map(function(a) {
      return {
        id: a.id,
        title: a.title,
        version: a.version,
        status: a.status,
        video_url: a.video_url,
        thumb_time: a.thumb_time,
        notes: commentCounts[a.id] || 0,
        date: new Date(a.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        created_at: a.created_at
      };
    });

    return res.json({ assets: result });
  }

  if (req.method === 'PATCH') {
    // Update asset status
    var { assetId, status } = req.body;
    var validStatuses = ['needs_review', 'in_review', 'approved', 'archived'];
    if (!assetId || !validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid assetId or status' });
    }

    const { error } = await adminClient
      .from('review_assets')
      .update({ status: status, updated_at: new Date().toISOString() })
      .eq('id', assetId)
      .eq('project_id', projectId);

    if (error) {
      console.error('Status update error:', error.message);
      return res.status(500).json({ error: 'Failed to update status' });
    }

    return res.json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
