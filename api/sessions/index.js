const { getAuthUser } = require('../../lib/auth');
const { adminClient } = require('../../lib/supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await getAuthUser(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const today = new Date().toISOString().split('T')[0];

  const { data: sessions, error } = await adminClient
    .from('sessions')
    .select('id, session_date, session_time, status, project_id, created_at')
    .eq('user_id', auth.id)
    .neq('status', 'cancelled')
    .gte('session_date', today)
    .order('session_date', { ascending: true })
    .order('session_time', { ascending: true });

  if (error) {
    console.error('Session list error:', error.message);
    return res.status(500).json({ error: 'Failed to fetch sessions' });
  }

  res.json({ sessions: sessions || [] });
};
