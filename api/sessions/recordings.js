const { getAuthUser } = require('../../lib/auth');
const { adminClient } = require('../../lib/supabase');

const DAILY_API = 'https://api.daily.co/v1';

async function dailyFetch(path, opts = {}) {
  const res = await fetch(`${DAILY_API}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.DAILY_API_KEY}`,
      ...opts.headers
    }
  });
  const body = await res.json();
  if (!res.ok) {
    const msg = body.error || body.info || JSON.stringify(body);
    throw new Error(`Daily API ${res.status}: ${msg}`);
  }
  return body;
}

async function listRecordings(roomName) {
  const data = await dailyFetch(`/recordings?room_name=${encodeURIComponent(roomName)}`);
  return (data.data || []).map(function(r) {
    return {
      id: r.id,
      room_name: r.room_name,
      duration: r.duration,
      started_at: r.start_ts,
      status: r.status,
      max_participants: r.max_participants,
      tracks: r.tracks
    };
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await getAuthUser(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const { project_id } = req.query;
  if (!project_id) {
    return res.status(400).json({ error: 'project_id is required' });
  }

  const { data: membership } = await adminClient
    .from('project_members')
    .select('project_id')
    .eq('user_id', auth.id)
    .eq('project_id', project_id)
    .maybeSingle();

  if (!membership) {
    return res.status(403).json({ error: 'You do not have access to that project' });
  }

  const roomName = `nipc-${project_id.slice(0, 8)}`;

  try {
    const recordings = await listRecordings(roomName);
    res.json({ recordings });
  } catch (err) {
    console.error('List recordings error:', err.message);
    res.status(500).json({ error: 'Failed to fetch recordings' });
  }
};
