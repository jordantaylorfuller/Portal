const { getAuthUser } = require('../../lib/auth');
const { adminClient } = require('../../lib/supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await getAuthUser(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const { id } = req.query;

  const { data: session } = await adminClient
    .from('sessions')
    .select('id, user_id')
    .eq('id', id)
    .single();

  if (!session) return res.status(404).json({ error: 'Session not found' });

  if (session.user_id !== auth.id) {
    return res.status(403).json({ error: 'Not authorized to cancel this session' });
  }

  const { error } = await adminClient
    .from('sessions')
    .update({ status: 'cancelled' })
    .eq('id', id);

  if (error) {
    console.error('Session cancel error:', error.message);
    return res.status(500).json({ error: 'Failed to cancel session' });
  }

  res.json({ ok: true });
};
