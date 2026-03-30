const { getAuthUser } = require('../../lib/auth');
const { adminClient } = require('../../lib/supabase');
const { getOrCreateRoom, createMeetingToken } = require('../../lib/daily');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await getAuthUser(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const { project_id } = req.body;
  if (!project_id) {
    return res.status(400).json({ error: 'project_id is required' });
  }

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

  if (!membership || !membership.projects) {
    return res.status(403).json({ error: 'You do not have access to that project' });
  }

  const { data: profile } = await adminClient
    .from('user_profiles')
    .select('display_name')
    .eq('id', auth.id)
    .maybeSingle();

  const displayName = (profile && profile.display_name) || auth.email;
  const isOwner = membership.role === 'lead';

  try {
    const room = await getOrCreateRoom(project_id, membership.projects.name);
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
      projectName: membership.projects.name
    });
  } catch (err) {
    console.error('Daily room/token error:', err.message);
    res.status(500).json({ error: 'Failed to create session room' });
  }
};
