const { requireProjectAccess } = require('../../../lib/auth');
const { adminClient } = require('../../../lib/supabase');

const COLUMN_BY_ROOM = {
  review: 'review_seen_at',
  delivery: 'delivery_seen_at'
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { projectId } = req.query;
  const result = await requireProjectAccess(req, res, projectId);
  if (!result) return;

  const room = (req.body && req.body.room) || '';
  const column = COLUMN_BY_ROOM[room];
  if (!column) return res.status(400).json({ error: 'Invalid room' });

  // Admins viewing a project they're not a member of have nothing to mark —
  // unseen counts are membership-scoped.
  const { error } = await adminClient
    .from('project_members')
    .update({ [column]: new Date().toISOString() })
    .eq('project_id', projectId)
    .eq('user_id', result.auth.id);

  if (error) {
    console.error('room-seen update error:', error.message);
    return res.status(500).json({ error: 'Failed to update' });
  }

  res.json({ success: true });
};
