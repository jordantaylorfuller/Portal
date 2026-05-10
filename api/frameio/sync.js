// POST /api/frameio/sync?project=<portal_project_id>
// Pulls files from the linked Frame.io project's root folder and upserts
// them into review_assets. Ensures each file has a Share whose short_url
// becomes frameio_review_url. Returns { synced, created, updated, errors }.

const { requireAdmin } = require('../../lib/frameio-admin');
const { adminClient } = require('../../lib/supabase');
const fio = require('../../lib/frameio');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!(await requireAdmin(req, res))) return;

  const portalProjectId = req.query.project || (req.body && req.body.project);
  if (!portalProjectId) return res.status(400).json({ error: 'project required' });

  try {
    const result = await syncOne(portalProjectId);
    return res.json(result);
  } catch (err) {
    console.error('Frame.io sync error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// Exported for sync-all cron entrypoint.
module.exports.syncOne = syncOne;

async function syncOne(portalProjectId) {
  const { data: project, error: projectErr } = await adminClient
    .from('projects')
    .select('id, name, frameio_account_id, frameio_workspace_id, frameio_project_id, frameio_root_folder_id')
    .eq('id', portalProjectId)
    .single();
  if (projectErr || !project) throw new Error('Portal project not found');
  if (!project.frameio_project_id) {
    throw new Error('Portal project is not linked to a Frame.io project');
  }

  // Resolve root_folder_id if missing (cache it on the row).
  let rootFolderId = project.frameio_root_folder_id;
  let accountId = project.frameio_account_id;
  if (!rootFolderId || !accountId) {
    if (!accountId) {
      const me = await fio.getMe();
      accountId = me && me.account_id;
      if (!accountId) throw new Error('No account_id available');
    }
    const fp = await fio.getProject(accountId, project.frameio_project_id);
    if (!fp) throw new Error('Frame.io project not found');
    rootFolderId = fp.root_folder_id || (fp.root_folder && fp.root_folder.id) || null;
    if (!rootFolderId) throw new Error('No root_folder_id on Frame.io project');
    await adminClient.from('projects')
      .update({ frameio_account_id: accountId, frameio_root_folder_id: rootFolderId })
      .eq('id', portalProjectId);
  }

  // Walk root folder children. Recurse one level into subfolders so
  // version-stack containers and a typical "Cuts/" subfolder both get picked
  // up. Deeper recursion can be added later if Buffalo's tree is deeper.
  const stack = [{ folderId: rootFolderId, depth: 0 }];
  const files = [];
  const MAX_DEPTH = 2;
  while (stack.length) {
    const { folderId, depth } = stack.pop();
    let children;
    try {
      children = await fio.listFolderChildren(accountId, folderId);
    } catch (err) {
      console.error(`listFolderChildren ${folderId} failed:`, err.message);
      continue;
    }
    for (const item of children) {
      const type = item.type || (item._type && item._type.toLowerCase());
      if (type === 'folder' && depth < MAX_DEPTH) {
        stack.push({ folderId: item.id, depth: depth + 1 });
      } else if (type === 'file' || type === 'version_stack') {
        files.push(item);
      }
    }
  }

  let created = 0;
  let updated = 0;
  const errors = [];

  for (const file of files) {
    try {
      const upserted = await upsertReviewAsset({
        portalProjectId,
        accountId,
        frameioProjectId: project.frameio_project_id,
        file
      });
      if (upserted.created) created++;
      else if (upserted.updated) updated++;
    } catch (err) {
      errors.push({ frameio_asset_id: file.id, error: err.message });
    }
  }

  return { ok: true, synced: files.length, created, updated, errors };
}

async function upsertReviewAsset({ portalProjectId, accountId, frameioProjectId, file }) {
  const fileId = file.id;
  const title = file.name || file.title || 'Untitled';
  const version = parseVersion(file);
  const { mapped: status, raw: statusRaw } = fio.readStatusFromFile(file);
  const thumbUrl = file.thumbnail_url || file.thumb_url ||
                   (file.thumbnails && file.thumbnails.large) || null;

  // Look up existing row by frameio_asset_id.
  const { data: existing } = await adminClient
    .from('review_assets')
    .select('id, frameio_share_id, frameio_review_url')
    .eq('frameio_asset_id', fileId)
    .maybeSingle();

  // Step 1: ensure the review_assets row exists. Do this BEFORE creating a
  // Frame.io Share so an insert failure can't leave orphan Shares behind.
  const baseRow = {
    project_id: portalProjectId,
    title,
    version,
    status,
    frameio_asset_id: fileId,
    frameio_thumb_url: thumbUrl || null,
    frameio_status_raw: statusRaw || null,
    frameio_synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  let rowId;
  let result;
  if (existing) {
    const { error } = await adminClient
      .from('review_assets').update(baseRow).eq('id', existing.id);
    if (error) throw new Error(error.message);
    rowId = existing.id;
    result = { updated: true };
  } else {
    const { data: inserted, error } = await adminClient
      .from('review_assets').insert(baseRow).select('id').single();
    if (error) throw new Error(error.message);
    rowId = inserted.id;
    result = { created: true };
  }

  // Step 2: ensure a Share exists for this row. Best-effort — if it fails,
  // the row is still tracked and the next sync will retry.
  const needsShare = !(existing && existing.frameio_share_id && existing.frameio_review_url);
  if (needsShare) {
    try {
      const share = await fio.createShare(accountId, frameioProjectId, {
        name: title, type: 'review'
      });
      if (share && share.id) {
        await fio.addAssetToShare(accountId, share.id, [fileId]);
        const fresh = await fio.getShare(accountId, share.id);
        const reviewUrl = (fresh && fresh.short_url) || share.short_url || null;
        await adminClient.from('review_assets').update({
          frameio_share_id: share.id,
          frameio_review_url: reviewUrl,
          updated_at: new Date().toISOString()
        }).eq('id', rowId);
      }
    } catch (err) {
      console.error('createShare failed for', fileId, err.message);
    }
  }

  return result;
}

function parseVersion(file) {
  // Try a few likely places. Frame.io's "version" of a file is usually the
  // version stack position; for plain files we fall back to a regex on the
  // filename ("foo_v003.mov").
  if (file.version && typeof file.version === 'string') return file.version;
  if (file.version_number != null) return `v${file.version_number}`;
  const name = file.name || '';
  const m = name.match(/[._-]v(\d+)\b/i);
  return m ? `v${m[1]}` : null;
}
