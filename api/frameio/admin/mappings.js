// GET  /api/frameio/admin/mappings  — list portal projects with Frame.io linkage.
// POST /api/frameio/admin/mappings  — bind a portal project to a Frame.io project.
//   body: { project_id, frameio_account_id, frameio_workspace_id, frameio_project_id, frameio_root_folder_id }
// DELETE                            — unbind: { project_id }

const { requireAdmin } = require('../../../lib/frameio-admin');
const { adminClient } = require('../../../lib/supabase');

module.exports = async function handler(req, res) {
  if (!(await requireAdmin(req, res))) return;

  if (req.method === 'GET') {
    const { data, error } = await adminClient
      .from('projects')
      .select('id, name, display_name, members_count, frameio_project_name, status, is_visible_to_clients, frameio_account_id, frameio_workspace_id, frameio_project_id, frameio_root_folder_id, frameio_archived_at')
      .order('frameio_project_name', { ascending: false, nullsFirst: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ projects: data || [] });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const { project_id, frameio_account_id, frameio_workspace_id,
            frameio_project_id, frameio_root_folder_id } = body;
    if (!project_id || !frameio_project_id) {
      return res.status(400).json({ error: 'project_id and frameio_project_id required' });
    }
    const { error } = await adminClient
      .from('projects')
      .update({
        frameio_account_id: frameio_account_id || null,
        frameio_workspace_id: frameio_workspace_id || null,
        frameio_project_id,
        frameio_root_folder_id: frameio_root_folder_id || null
      })
      .eq('id', project_id);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true });
  }

  if (req.method === 'DELETE') {
    const projectId = (req.body && req.body.project_id) || req.query.project_id;
    if (!projectId) return res.status(400).json({ error: 'project_id required' });
    const { error } = await adminClient
      .from('projects')
      .update({
        frameio_account_id: null,
        frameio_workspace_id: null,
        frameio_project_id: null,
        frameio_root_folder_id: null
      })
      .eq('id', projectId);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
