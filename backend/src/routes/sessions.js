const { Router } = require('express');
const { adminClient } = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');

const router = Router();

// POST /api/sessions/book
// Book a session for the authenticated user
router.post('/book', requireAuth, async (req, res) => {
  const { date, time, project_id } = req.body;
  if (!date || !time || !project_id) {
    return res.status(400).json({ error: 'date, time, and project_id are required' });
  }

  // Validate date is not in the past
  const sessionDate = new Date(date + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (sessionDate < today) {
    return res.status(400).json({ error: 'Cannot book a session in the past' });
  }

  // Validate weekday
  const day = sessionDate.getDay();
  if (day === 0 || day === 6) {
    return res.status(400).json({ error: 'Sessions are only available on weekdays' });
  }

  const { data: membership, error: membershipError } = await adminClient
    .from('project_members')
    .select('project_id, projects(id, name, status)')
    .eq('user_id', req.user.id)
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

  // Check for duplicate booking (same user, same date+time)
  const { data: existing } = await adminClient
    .from('sessions')
    .select('id')
    .eq('user_id', req.user.id)
    .eq('session_date', date)
    .eq('session_time', time)
    .neq('status', 'cancelled')
    .maybeSingle();

  if (existing) {
    return res.status(409).json({ error: 'You already have a session booked at this time' });
  }

  // Insert the session
  const { data: session, error } = await adminClient
    .from('sessions')
    .insert({
      user_id: req.user.id,
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

  console.log(`Session booked: ${req.user.email} on ${date} at ${time} for ${membership.projects.name}`);
  res.json({ ok: true, session });
});

// GET /api/sessions
// List the authenticated user's upcoming sessions
router.get('/', requireAuth, async (req, res) => {
  const today = new Date().toISOString().split('T')[0];

  const { data: sessions, error } = await adminClient
    .from('sessions')
    .select('id, session_date, session_time, status, project_id, created_at')
    .eq('user_id', req.user.id)
    .neq('status', 'cancelled')
    .gte('session_date', today)
    .order('session_date', { ascending: true })
    .order('session_time', { ascending: true });

  if (error) {
    console.error('Session list error:', error.message);
    return res.status(500).json({ error: 'Failed to fetch sessions' });
  }

  res.json({ sessions: sessions || [] });
});

// DELETE /api/sessions/:id
// Cancel a session
router.delete('/:id', requireAuth, async (req, res) => {
  const { id } = req.params;

  // Verify ownership
  const { data: session } = await adminClient
    .from('sessions')
    .select('id, user_id')
    .eq('id', id)
    .single();

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (session.user_id !== req.user.id) {
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
});

module.exports = router;
