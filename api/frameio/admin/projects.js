// GET /api/frameio/admin/projects?workspace_id=... — list projects in a workspace.

const { requireAdmin } = require('../../../lib/frameio-admin');
const { getMe, listProjects } = require('../../../lib/frameio');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!(await requireAdmin(req, res))) return;

  const workspaceId = req.query.workspace_id;
  if (!workspaceId) return res.status(400).json({ error: 'workspace_id required' });

  try {
    const me = await getMe();
    if (!me || !me.account_id) {
      return res.status(412).json({ error: 'No account_id from Frame.io /me' });
    }
    const projects = await listProjects(me.account_id, String(workspaceId));
    return res.json({
      projects: projects.map(p => ({
        id: p.id,
        name: p.name,
        root_folder_id: p.root_folder_id || (p.root_folder && p.root_folder.id) || null
      }))
    });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
};
