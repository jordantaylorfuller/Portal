// POST /api/frameio/sync-projects
// Discovers every Frame.io project in the connected account and upserts
// each as a portal `projects` row keyed by frameio_project_id. New rows
// land with is_visible_to_clients=false. Existing rows have their name +
// frameio_* fields refreshed but visibility/status preserved.
//
// Returns { ok, created, updated, total }.

const { requireAdmin } = require('../../lib/frameio-admin');
const { adminClient } = require('../../lib/supabase');
const fio = require('../../lib/frameio');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!(await requireAdmin(req, res))) return;

  try {
    const result = await discoverAndUpsertProjects();
    return res.json(result);
  } catch (err) {
    console.error('Frame.io sync-projects error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// Exported for sync-all (cron) and webhooks.
module.exports.discoverAndUpsertProjects = discoverAndUpsertProjects;

async function discoverAndUpsertProjects() {
  const me = await fio.getMe();
  const accountId = me && me.account_id;
  if (!accountId) throw new Error('No account_id from Frame.io /me + /accounts');

  const projects = await fio.listAllProjects(accountId);

  let created = 0;
  let updated = 0;

  for (const p of projects) {
    const frameioName = p.name || '';
    const stripped = fio.stripProjectPrefix(frameioName);
    const rootFolderId = p.root_folder_id || (p.root_folder && p.root_folder.id) || null;

    // Look up existing row by frameio_project_id.
    const { data: existing } = await adminClient
      .from('projects')
      .select('id, status, is_visible_to_clients')
      .eq('frameio_project_id', p.id)
      .maybeSingle();

    if (existing) {
      // Update name + provenance only. Don't touch status or visibility — admin owns those.
      const { error } = await adminClient
        .from('projects')
        .update({
          name: stripped,
          frameio_project_name: frameioName,
          frameio_account_id: accountId,
          frameio_workspace_id: p.workspace_id || null,
          frameio_root_folder_id: rootFolderId,
          frameio_archived_at: null
        })
        .eq('id', existing.id);
      if (error) {
        console.error('sync-projects update failed for', p.id, error.message);
        continue;
      }
      updated++;
    } else {
      const { error } = await adminClient
        .from('projects')
        .insert({
          name: stripped,
          status: 'active',
          is_visible_to_clients: false,
          frameio_project_name: frameioName,
          frameio_account_id: accountId,
          frameio_workspace_id: p.workspace_id || null,
          frameio_project_id: p.id,
          frameio_root_folder_id: rootFolderId
        });
      if (error) {
        console.error('sync-projects insert failed for', p.id, error.message);
        continue;
      }
      created++;
    }
  }

  return { ok: true, created, updated, total: projects.length };
}
