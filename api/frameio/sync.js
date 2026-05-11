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

async function upsertReviewAsset({ portalProjectId, accountId, frameioProjectId, file: folderChild }) {
  // The row's stable identity. For version_stacks this stays the stack id
  // across version uploads; for plain files it's just the file id.
  const stableId = folderChild.id;

  // Resolve the actual file we'll pull media/metadata from. For version
  // stacks that's the head_version (latest upload); for plain files it's
  // the item itself.
  let headFileId = stableId;
  if ((folderChild.type || '').toLowerCase() === 'version_stack') {
    try {
      const stack = await fio.getVersionStack(accountId, stableId);
      if (stack && stack.head_version && stack.head_version.id) {
        headFileId = stack.head_version.id;
      } else {
        console.error('version_stack returned no head_version:', stableId);
      }
    } catch (err) {
      console.error('getVersionStack failed for', stableId, err.message);
    }
  }

  // The folder-listing response is sparse — fetch the full file with the
  // media_links.thumbnail include so we get the signed thumbnail URL,
  // the metadata array (Comment Count, Duration, Date Uploaded), and the
  // top-level file_size/media_type/created_at fields.
  let file = folderChild;
  try {
    const full = await fio.getFile(accountId, headFileId, { include: 'metadata,media_links.thumbnail' });
    if (full) file = full;
  } catch (err) {
    console.error('getFile failed for', headFileId, err.message);
    // Continue with the sparse folder-child payload; thumb/metadata fields
    // will simply be null this cycle and refresh on the next successful run.
  }

  const title = file.name || file.title || 'Untitled';
  const version = parseVersion(file);
  const { mapped: status, raw: statusRaw } = fio.readStatusFromFile(file);

  const thumbUrl = (file.media_links && file.media_links.thumbnail && file.media_links.thumbnail.url) || null;
  const dateUploaded = fio.readFileMetadata(file, 'Date Uploaded');
  const commentCount = fio.readFileMetadata(file, 'Comment Count');
  const durationSec  = fio.readFileMetadata(file, 'Duration');
  const frameioCreatedAt = (typeof dateUploaded === 'string' && dateUploaded)
    ? dateUploaded
    : (file.created_at || null);

  // Look up existing row by stable frameio_asset_id (stack id for stacks,
  // file id for plain files).
  const { data: existing } = await adminClient
    .from('review_assets')
    .select('id, frameio_share_id, frameio_review_url')
    .eq('frameio_asset_id', stableId)
    .maybeSingle();

  // Step 1: ensure the review_assets row exists. Do this BEFORE creating a
  // Frame.io Share so an insert failure can't leave orphan Shares behind.
  const baseRow = {
    project_id: portalProjectId,
    title,
    version,
    status,
    frameio_asset_id: stableId,
    frameio_head_file_id: headFileId,
    frameio_thumb_url: thumbUrl,
    frameio_status_raw: statusRaw || null,
    frameio_created_at: frameioCreatedAt,
    frameio_duration_seconds: typeof durationSec === 'number' ? durationSec : null,
    frameio_file_size: typeof file.file_size === 'number' ? file.file_size : null,
    frameio_media_type: file.media_type || null,
    notes_count: Number.isFinite(commentCount) ? commentCount : 0,
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

  // Step 2: ensure a Share exists for this row. v4 lets us create-with-assets
  // in one call; short_url is in the response.
  const needsShare = !(existing && existing.frameio_share_id && existing.frameio_review_url);
  if (needsShare) {
    try {
      const share = await fio.createShare(accountId, frameioProjectId, {
        name: title,
        assetIds: [stableId],
        access: 'public'
      });
      if (share && share.id) {
        await adminClient.from('review_assets').update({
          frameio_share_id: share.id,
          frameio_review_url: share.short_url || null,
          updated_at: new Date().toISOString()
        }).eq('id', rowId);
      }
    } catch (err) {
      console.error('createShare failed for', stableId, err.message);
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
