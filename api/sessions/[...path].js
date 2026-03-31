const { getAuthUser } = require('../../lib/auth');
const { adminClient } = require('../../lib/supabase');
const { getOrCreateRoom, createMeetingToken, listRecordings, getRecordingLink } = require('../../lib/daily');

module.exports = async function handler(req, res) {
  const auth = await getAuthUser(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  // Parse path from URL as fallback since req.query.path may be empty
  let raw = req.query.path;
  if (!raw || (Array.isArray(raw) && raw.length === 0)) {
    const match = req.url.match(/\/api\/sessions\/([^?]*)/);
    if (match && match[1]) raw = match[1].split('/').filter(Boolean);
  }
  const segments = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const route = segments.join('/');

  // GET /api/sessions/list
  if (route === 'list' && req.method === 'GET') {
    return listSessions(req, res, auth);
  }

  // POST /api/sessions/book
  if (route === 'book' && req.method === 'POST') {
    return bookSession(req, res, auth);
  }

  // POST /api/sessions/join
  if (route === 'join' && req.method === 'POST') {
    return joinSession(req, res, auth);
  }

  // GET /api/sessions/recordings
  if (route === 'recordings' && req.method === 'GET') {
    return listSessionRecordings(req, res, auth);
  }

  // GET /api/sessions/recordings/:id/link
  if (segments.length === 3 && segments[0] === 'recordings' && segments[2] === 'link' && req.method === 'GET') {
    return getSessionRecordingLink(req, res, auth, segments[1]);
  }

  // DELETE /api/sessions/:id
  if (segments.length === 1 && req.method === 'DELETE') {
    return cancelSession(req, res, auth, segments[0]);
  }

  return res.status(404).json({ error: 'Not found' });
};

// ── List upcoming sessions ──
async function listSessions(req, res, auth) {
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
}

// ── Book a session ──
async function bookSession(req, res, auth) {
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
}

// ── Join a Daily.co session ──
async function joinSession(req, res, auth) {
  const { project_id } = req.body;

  const { data: profile } = await adminClient
    .from('user_profiles')
    .select('display_name')
    .eq('id', auth.id)
    .maybeSingle();

  const displayName = (profile && profile.display_name) || auth.email;

  // If a project_id is provided, validate membership and use project room
  let roomProjectId = project_id;
  let projectName = 'NIPC Session';
  let isOwner = false;

  if (project_id) {
    const { data: membership, error: membershipError } = await adminClient
      .from('project_members')
      .select('project_id, role, projects(id, name, status)')
      .eq('user_id', auth.id)
      .eq('project_id', project_id)
      .maybeSingle();

    if (membershipError) {
      console.error('Project membership lookup error:', membershipError.message);
      return res.status(500).json({ error: 'Failed to validate project access' });
    }

    if (membership && membership.projects) {
      projectName = membership.projects.name;
      isOwner = membership.role === 'lead';
    }
  }

  // Fallback to a dev room if no project
  if (!roomProjectId) {
    roomProjectId = 'dev-room0';
  }

  try {
    const room = await getOrCreateRoom(roomProjectId, projectName);
    const token = await createMeetingToken(room.name, {
      userName: displayName,
      userId: auth.id,
      isOwner
    });

    console.log(`Session join: ${displayName} -> ${room.url} (owner: ${isOwner})`);
    res.json({
      url: room.url,
      token,
      roomName: room.name,
      projectName
    });
  } catch (err) {
    console.error('Daily room/token error:', err.message);
    res.status(500).json({ error: 'Failed to create session room' });
  }
}

// ── List recordings for a project ──
async function listSessionRecordings(req, res, auth) {
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
}

// ── Get recording playback link ──
async function getSessionRecordingLink(req, res, auth, recordingId) {
  try {
    const url = await getRecordingLink(recordingId);
    res.json({ url });
  } catch (err) {
    console.error('Recording link error:', err.message);
    res.status(500).json({ error: 'Failed to get recording link' });
  }
}

// ── Cancel a session ──
async function cancelSession(req, res, auth, id) {
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
}
