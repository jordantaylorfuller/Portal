// GET   /api/projects/:projectId  — admin: full project row for settings panel.
// PATCH /api/projects/:projectId  — admin: update display_name, is_visible_to_clients, status.
//   When status flips to 'archived', frameio_archived_at is set to now().
//   When status flips back to 'active', frameio_archived_at is cleared.

const { requireAdmin } = require('../../lib/frameio-admin');
const { adminClient } = require('../../lib/supabase');

const PROJECT_COLUMNS =
  'id, name, display_name, members_count, status, is_visible_to_clients, ' +
  'frameio_project_id, frameio_project_name, frameio_account_id, ' +
  'frameio_workspace_id, frameio_root_folder_id, frameio_archived_at, created_at';

module.exports = async function handler(req, res) {
  if (!(await requireAdmin(req, res))) return;

  const { projectId } = req.query;
  if (!projectId) return res.status(400).json({ error: 'projectId required' });

  if (req.method === 'GET') {
    const { data, error } = await adminClient
      .from('projects')
      .select(PROJECT_COLUMNS)
      .eq('id', projectId)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Project not found' });
    return res.json({ project: data });
  }

  if (req.method === 'PATCH') {
    const body = req.body || {};
    const patch = {};

    if (Object.prototype.hasOwnProperty.call(body, 'display_name')) {
      const v = body.display_name;
      if (v === null || v === '') patch.display_name = null;
      else if (typeof v !== 'string') return res.status(400).json({ error: 'display_name must be string or null' });
      else patch.display_name = v.trim();
    }

    if (Object.prototype.hasOwnProperty.call(body, 'is_visible_to_clients')) {
      if (typeof body.is_visible_to_clients !== 'boolean') {
        return res.status(400).json({ error: 'is_visible_to_clients must be boolean' });
      }
      patch.is_visible_to_clients = body.is_visible_to_clients;
    }

    let statusChange = null;
    if (Object.prototype.hasOwnProperty.call(body, 'status')) {
      if (body.status !== 'active' && body.status !== 'archived') {
        return res.status(400).json({ error: "status must be 'active' or 'archived'" });
      }
      patch.status = body.status;
      statusChange = body.status;
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    if (statusChange !== null) {
      const { data: prior } = await adminClient
        .from('projects')
        .select('status')
        .eq('id', projectId)
        .maybeSingle();
      if (!prior) return res.status(404).json({ error: 'Project not found' });
      if (statusChange === 'archived' && prior.status !== 'archived') {
        patch.frameio_archived_at = new Date().toISOString();
      } else if (statusChange === 'active' && prior.status === 'archived') {
        patch.frameio_archived_at = null;
      }
    }

    const { data, error } = await adminClient
      .from('projects')
      .update(patch)
      .eq('id', projectId)
      .select(PROJECT_COLUMNS)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Project not found' });
    return res.json({ project: data });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
