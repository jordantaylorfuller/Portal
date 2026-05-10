// POST /api/webhooks/frameio
// Receives Frame.io webhook events. Verifies the v0 HMAC signature, then
// dispatches based on event type to update review_assets state.
//
// All events are filtered by frameio_asset_id (or frameio_share_id) match
// against an existing row. Unknown IDs are logged and ignored — sync owns
// row creation, webhooks own state mirroring.

const { adminClient } = require('../../lib/supabase');
const fio = require('../../lib/frameio');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const raw = await readRaw(req);
  if (!fio.verifyWebhookSignature(raw, req.headers)) {
    console.error('Frame.io webhook signature mismatch');
    return res.status(401).json({ error: 'Bad signature' });
  }

  let event;
  try { event = JSON.parse(raw); }
  catch { return res.status(400).json({ error: 'Bad JSON' }); }

  const type = event.type || event.event_type;
  const resource = event.resource || {};
  const resourceId = resource.id;

  try {
    await dispatch(type, resourceId, event);
  } catch (err) {
    // Don't fail the response — Frame.io retries on non-2xx and we'd just
    // get duplicate processing. Log and ack.
    console.error(`Frame.io webhook ${type} for ${resourceId} failed:`, err.message);
  }

  res.status(200).json({ ok: true });
};

module.exports.config = { api: { bodyParser: false } };

async function dispatch(type, resourceId, event) {
  if (!type || !resourceId) return;

  // Project lifecycle → keep portal projects in sync.
  if (type === 'project.created' || type === 'project.updated') {
    await onProjectUpsert(resourceId);
    return;
  }
  if (type === 'project.deleted') {
    await adminClient.from('projects')
      .update({
        status: 'archived',
        is_visible_to_clients: false,
        frameio_archived_at: new Date().toISOString()
      })
      .eq('frameio_project_id', resourceId);
    return;
  }

  // File / metadata events → status mirror.
  if (type === 'metadata.value.updated' || type === 'file.updated') {
    await onFileMaybeChanged(resourceId, event);
    return;
  }
  if (type === 'file.deleted' || type === 'asset.deleted') {
    await adminClient.from('review_assets')
      .update({ status: 'archived', updated_at: new Date().toISOString() })
      .eq('frameio_asset_id', resourceId);
    return;
  }
  if (type === 'file.ready' || type === 'file.upload.completed' || type === 'file.versioned') {
    // No-op for state; sync will pick these up. Could optimistically refresh.
    return;
  }

  // Comment events → notes_count.
  if (type === 'comment.created') {
    await bumpComments(event, +1);
    return;
  }
  if (type === 'comment.deleted') {
    await bumpComments(event, -1);
    return;
  }
  // updated/completed/uncompleted don't change the count.

  // Share events: capture short_url when one is created out-of-band.
  if (type === 'share.created' || type === 'share.updated') {
    // Resource here is the share; its `assets` (if present) tell us which
    // file IDs to associate. We don't auto-create rows; only attach the URL
    // if a file already has a row.
    await onShareEvent(resourceId, event);
    return;
  }
  if (type === 'share.deleted') {
    await adminClient.from('review_assets')
      .update({ frameio_review_url: null, frameio_share_id: null, updated_at: new Date().toISOString() })
      .eq('frameio_share_id', resourceId);
    return;
  }
}

async function onProjectUpsert(projectId) {
  const me = await fio.getMe().catch(() => null);
  const accountId = me && me.account_id;
  if (!accountId) return;
  const project = await fio.getProject(accountId, projectId).catch(err => {
    console.error('webhook getProject failed for', projectId, err.message);
    return null;
  });
  if (!project) return;

  const frameioName = project.name || '';
  const stripped = fio.stripProjectPrefix(frameioName);
  const rootFolderId = project.root_folder_id || (project.root_folder && project.root_folder.id) || null;

  const { data: existing } = await adminClient
    .from('projects')
    .select('id')
    .eq('frameio_project_id', projectId)
    .maybeSingle();

  if (existing) {
    await adminClient.from('projects').update({
      name: stripped,
      frameio_project_name: frameioName,
      frameio_account_id: accountId,
      frameio_root_folder_id: rootFolderId,
      frameio_archived_at: null
    }).eq('id', existing.id);
  } else {
    await adminClient.from('projects').insert({
      name: stripped,
      status: 'active',
      is_visible_to_clients: false,
      frameio_project_name: frameioName,
      frameio_account_id: accountId,
      frameio_project_id: projectId,
      frameio_root_folder_id: rootFolderId
    });
  }
}

async function onFileMaybeChanged(fileId, event) {
  // Check if we have a row first — avoid hitting Frame.io API for events
  // about files we don't track.
  const { data: row } = await adminClient
    .from('review_assets')
    .select('id, project_id')
    .eq('frameio_asset_id', fileId)
    .maybeSingle();
  if (!row) return;

  // Best-effort: pull current state from API.
  let accountId = null;
  try {
    const { data: project } = await adminClient
      .from('projects').select('frameio_account_id').eq('id', row.project_id).single();
    accountId = project && project.frameio_account_id;
  } catch (_) {}
  if (!accountId) {
    const me = await fio.getMe().catch(() => null);
    accountId = me && me.account_id;
  }
  if (!accountId) return;

  const file = await fio.getFile(accountId, fileId).catch(err => {
    console.error('getFile failed in webhook for', fileId, err.message);
    return null;
  });
  if (!file) return;

  const { mapped: status, raw: statusRaw } = fio.readStatusFromFile(file);
  await adminClient.from('review_assets').update({
    status,
    frameio_status_raw: statusRaw || null,
    title: file.name || undefined,
    frameio_thumb_url: file.thumbnail_url || file.thumb_url || null,
    updated_at: new Date().toISOString()
  }).eq('id', row.id);
}

async function bumpComments(event, delta) {
  // Determine which file the comment belongs to. Payload shapes vary; look
  // for the parent reference.
  const parent = event.resource && (event.resource.parent || event.resource.file);
  const fileId = parent && parent.id;
  if (!fileId) return;

  const { data: row } = await adminClient
    .from('review_assets')
    .select('id, notes_count')
    .eq('frameio_asset_id', fileId)
    .maybeSingle();
  if (!row) return;

  const next = Math.max(0, (row.notes_count || 0) + delta);
  await adminClient.from('review_assets')
    .update({ notes_count: next, updated_at: new Date().toISOString() })
    .eq('id', row.id);
}

async function onShareEvent(shareId, event) {
  // event.resource may include short_url in some payloads; otherwise fetch.
  const r = event.resource || {};
  let shortUrl = r.short_url;
  let assetIds = (r.asset_ids || (r.assets || []).map(a => a.id) || []).filter(Boolean);

  if (!shortUrl || assetIds.length === 0) {
    // Fetch the share to enrich.
    let accountId = null;
    const me = await fio.getMe().catch(() => null);
    accountId = me && me.account_id;
    if (!accountId) return;
    try {
      const share = await fio.getShare(accountId, shareId);
      if (share) {
        shortUrl = shortUrl || share.short_url;
        if (assetIds.length === 0 && Array.isArray(share.assets)) {
          assetIds = share.assets.map(a => a.id).filter(Boolean);
        }
      }
    } catch (err) {
      console.error('getShare failed in webhook for', shareId, err.message);
    }
  }

  if (!shortUrl || assetIds.length === 0) return;

  for (const fileId of assetIds) {
    await adminClient.from('review_assets').update({
      frameio_share_id: shareId,
      frameio_review_url: shortUrl,
      updated_at: new Date().toISOString()
    }).eq('frameio_asset_id', fileId);
  }
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
