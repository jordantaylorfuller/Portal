const { getAuthUser } = require('../../lib/auth');
const { adminClient } = require('../../lib/supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await getAuthUser(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const { date, time, project_id } = req.body;
  if (!date || !time || !project_id) {
    return res.status(400).json({ error: 'date, time, and project_id are required' });
  }

  const sessionDate = new Date(date + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (sessionDate < today) {
    return res.status(400).json({ error: 'Cannot book a session in the past' });
  }

  const day = sessionDate.getDay();
  if (day === 0 || day === 6) {
    return res.status(400).json({ error: 'Sessions are only available on weekdays' });
  }

  const { data: membership, error: membershipError } = await adminClient
    .from('project_members')
    .select('project_id, projects(id, name, status)')
    .eq('user_id', auth.id)
    .eq('project_id', project_id)
    .maybeSingle();

  if (membershipError) {
    console.error('Project membership lookup error:', membershipError.message);
    return res.status(500).json({ error: 'Failed to validate project access' });
  }

  if (!membership || !membership.projects) {
    return res.status(403).json({ error: 'You do not have access to that project' });
  }

  if (membership.projects.status !== 'active') {
    return res.status(400).json({ error: 'Sessions can only be booked for active projects' });
  }

  const { data: existing } = await adminClient
    .from('sessions')
    .select('id')
    .eq('user_id', auth.id)
    .eq('session_date', date)
    .eq('session_time', time)
    .neq('status', 'cancelled')
    .maybeSingle();

  if (existing) {
    return res.status(409).json({ error: 'You already have a session booked at this time' });
  }

  const { data: session, error } = await adminClient
    .from('sessions')
    .insert({
      user_id: auth.id,
      project_id,
      session_date: date,
      session_time: time,
      status: 'confirmed'
    })
    .select()
    .single();

  if (error) {
    console.error('Session booking error:', error.message);
    return res.status(500).json({ error: 'Failed to book session' });
  }

  console.log(`Session booked: ${auth.email} on ${date} at ${time} for ${membership.projects.name}`);
  res.json({ ok: true, session });
};
