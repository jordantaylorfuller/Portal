// GET /api/frameio/admin/me — returns the connected Frame.io user info,
// or 412 if Frame.io isn't connected yet.

const { requireAdmin } = require('../../../lib/frameio-admin');
const { adminClient } = require('../../../lib/supabase');
const { getMe } = require('../../../lib/frameio');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!(await requireAdmin(req, res))) return;

  const { data: token } = await adminClient
    .from('frameio_tokens').select('user_email, account_id, updated_at')
    .eq('name', 'default').maybeSingle();

  if (!token) {
    return res.status(412).json({ error: 'Frame.io not connected', connected: false });
  }

  try {
    const me = await getMe();
    return res.json({
      connected: true,
      account_id: (me && me.account_id) || token.account_id,
      email: (me && me.email) || token.user_email,
      name: me && me.name,
      last_refreshed_at: token.updated_at
    });
  } catch (err) {
    return res.status(502).json({
      connected: false,
      error: err.message
    });
  }
};
