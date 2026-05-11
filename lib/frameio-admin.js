// Shared admin-gate for /api/frameio/admin/* endpoints.
// Returns the auth object on success, or sends 401/403 and returns null.

const { getAuthUser } = require('./auth');
const { adminClient } = require('./supabase');
const { isAdmin } = require('./admin');

async function requireAdmin(req, res) {
  const auth = await getAuthUser(req);
  if (!auth) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  const { data: profile } = await adminClient
    .from('user_profiles').select('role').eq('id', auth.id).maybeSingle();
  if (!isAdmin(profile, auth.email)) {
    res.status(403).json({ error: 'Admin only' });
    return null;
  }
  return auth;
}

module.exports = { requireAdmin };
