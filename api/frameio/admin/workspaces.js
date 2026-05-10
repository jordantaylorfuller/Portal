// GET /api/frameio/admin/workspaces — list workspaces in the connected account.

const { requireAdmin } = require('../../../lib/frameio-admin');
const { getMe, listWorkspaces } = require('../../../lib/frameio');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!(await requireAdmin(req, res))) return;

  try {
    const me = await getMe();
    if (!me || !me.account_id) {
      return res.status(412).json({ error: 'No account_id from Frame.io /me' });
    }
    const workspaces = await listWorkspaces(me.account_id);
    return res.json({
      account_id: me.account_id,
      workspaces: workspaces.map(w => ({ id: w.id, name: w.name }))
    });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
};
