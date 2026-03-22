const { getAuthUser } = require('../../../lib/auth');
const { adminClient } = require('../../../lib/supabase');

module.exports = async function handler(req, res) {
  const auth = await getAuthUser(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const { assetId } = req.query;

  // Verify user has access to this asset's project
  const { data: asset } = await adminClient
    .from('review_assets')
    .select('id, project_id')
    .eq('id', assetId)
    .single();

  if (!asset) return res.status(404).json({ error: 'Asset not found' });

  const { data: membership } = await adminClient
    .from('project_members')
    .select('role')
    .eq('project_id', asset.project_id)
    .eq('user_id', auth.id)
    .single();

  if (!membership) return res.status(403).json({ error: 'No access' });

  if (req.method === 'GET') {
    const { data: comments, error } = await adminClient
      .from('review_comments')
      .select('id, user_id, timecode, text, resolved, created_at')
      .eq('asset_id', assetId)
      .order('timecode', { ascending: true });

    if (error) {
      console.error('Comments fetch error:', error.message);
      return res.status(500).json({ error: 'Failed to fetch comments' });
    }

    // Get user profiles for comment authors
    var userIds = [...new Set((comments || []).map(function(c) { return c.user_id; }))];
    var profiles = {};
    if (userIds.length > 0) {
      const { data: users } = await adminClient
        .from('user_profiles')
        .select('id, display_name, initials')
        .in('id', userIds);
      if (users) {
        users.forEach(function(u) { profiles[u.id] = u; });
      }
    }

    var result = (comments || []).map(function(c) {
      var profile = profiles[c.user_id] || { display_name: 'Unknown', initials: '??' };
      return {
        id: c.id,
        author: profile.display_name,
        initials: profile.initials,
        timecode: c.timecode,
        text: c.text,
        resolved: c.resolved,
        created_at: c.created_at
      };
    });

    return res.json({ comments: result });
  }

  if (req.method === 'POST') {
    var { timecode, text } = req.body;
    if (text === undefined || text.trim() === '') {
      return res.status(400).json({ error: 'Text is required' });
    }

    const { data: comment, error } = await adminClient
      .from('review_comments')
      .insert({
        asset_id: assetId,
        user_id: auth.id,
        timecode: timecode || 0,
        text: text.trim()
      })
      .select('id, timecode, text, resolved, created_at')
      .single();

    if (error) {
      console.error('Comment create error:', error.message);
      return res.status(500).json({ error: 'Failed to create comment' });
    }

    // Get author profile
    const { data: profile } = await adminClient
      .from('user_profiles')
      .select('display_name, initials')
      .eq('id', auth.id)
      .single();

    return res.status(201).json({
      comment: {
        id: comment.id,
        author: profile ? profile.display_name : 'Unknown',
        initials: profile ? profile.initials : '??',
        timecode: comment.timecode,
        text: comment.text,
        resolved: comment.resolved,
        created_at: comment.created_at
      }
    });
  }

  if (req.method === 'PATCH') {
    // Toggle resolved status
    var { commentId, resolved } = req.body;
    if (!commentId) return res.status(400).json({ error: 'commentId required' });

    const { error } = await adminClient
      .from('review_comments')
      .update({ resolved: !!resolved })
      .eq('id', commentId)
      .eq('asset_id', assetId);

    if (error) {
      console.error('Comment update error:', error.message);
      return res.status(500).json({ error: 'Failed to update comment' });
    }

    return res.json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
