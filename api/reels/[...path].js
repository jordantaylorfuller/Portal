const { customAlphabet } = require('nanoid');
const { getAuthUser } = require('../../lib/auth');
const { adminClient } = require('../../lib/supabase');
const { isAdmin } = require('../../lib/admin');
const { presignPut, presignGet, listPrefix, deleteObject } = require('../../lib/storj');
const { createAssetFromUrl, deleteAsset } = require('../../lib/mux');

// All routes are single-segment under /api/reels/<route>. IDs go in the body or query.
// Vercel's [...path].js catch-all only routes 1 path segment to the function on this runtime.

const slugId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 16);
const ROOT_PREFIX = (process.env.REELS_ROOT_PREFIX || 'reels/').replace(/\/+$/, '') + '/';
const VIDEO_EXTS = new Set(['mov', 'mp4', 'm4v', 'mkv', 'webm', 'avi', 'mxf']);

module.exports = async function handler(req, res) {
  const raw = req.query.path || req.query['...path'];
  const segments = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const route = segments[0] || '';

  try {
    if (route === 'public' && req.method === 'GET') return publicReel(req, res);

    if (route === 'sync-all' && req.method === 'POST') {
      const ok = isCronCall(req) || (await requireAdmin(req, res));
      if (!ok) return;
      return syncAll(req, res);
    }

    const auth = await requireAdmin(req, res);
    if (!auth) return;

    if (route === 'list' && req.method === 'GET') return listReels(res);
    if (route === 'admin-assets' && req.method === 'GET') return adminAssets(req, res);
    if (route === 'create' && req.method === 'POST') return createReel(req, res, auth);
    if (route === 'update' && req.method === 'POST') return patchReel(req, res);
    if (route === 'delete' && req.method === 'POST') return deleteReel(req, res);
    if (route === 'presign' && req.method === 'POST') return presignUpload(req, res);
    if (route === 'register-asset' && req.method === 'POST') return registerAsset(req, res);
    if (route === 'update-asset' && req.method === 'POST') return patchAsset(req, res);
    if (route === 'delete-asset' && req.method === 'POST') return deleteAssetRoute(req, res);
    if (route === 'sync' && req.method === 'POST') return syncReel(req, res);

    return res.status(404).json({ error: 'Not found', route, method: req.method });
  } catch (err) {
    console.error('reels handler error:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
};

function isCronCall(req) {
  const auth = req.headers.authorization;
  if (!auth || !process.env.CRON_SECRET) return false;
  return auth === 'Bearer ' + process.env.CRON_SECRET;
}

async function requireAdmin(req, res) {
  const auth = await getAuthUser(req);
  if (!auth) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  const { data: profile } = await adminClient
    .from('user_profiles')
    .select('role')
    .eq('id', auth.id)
    .maybeSingle();
  if (!isAdmin(profile, auth.email)) {
    res.status(403).json({ error: 'Admin role required' });
    return null;
  }
  return auth;
}

function humanizeFolder(name) {
  return name
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

function isVideoKey(key) {
  const ext = (key.split('.').pop() || '').toLowerCase();
  return VIDEO_EXTS.has(ext);
}

async function listReels(res) {
  const { data: reels, error } = await adminClient
    .from('reels')
    .select('id, slug, title, description, status, s3_prefix, auto_created, created_at, updated_at')
    .order('updated_at', { ascending: false });
  if (error) throw error;

  const ids = reels.map(r => r.id);
  let counts = {};
  if (ids.length) {
    const { data: assets } = await adminClient
      .from('reel_assets')
      .select('reel_id, status')
      .in('reel_id', ids);
    counts = (assets || []).reduce((acc, a) => {
      const c = acc[a.reel_id] || { ready: 0, total: 0 };
      c.total++;
      if (a.status === 'ready') c.ready++;
      acc[a.reel_id] = c;
      return acc;
    }, {});
  }

  res.json({
    reels: reels.map(r => ({ ...r, counts: counts[r.id] || { ready: 0, total: 0 } }))
  });
}

async function createReel(req, res, auth) {
  const { title, description } = req.body || {};
  if (!title || typeof title !== 'string') {
    return res.status(400).json({ error: 'title is required' });
  }
  const slug = slugId();
  const folder = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || slug;
  const s3_prefix = ROOT_PREFIX + folder + '/';

  const { data: reel, error } = await adminClient
    .from('reels')
    .insert({ slug, title, description: description || null, s3_prefix, status: 'draft', created_by: auth.id })
    .select()
    .single();
  if (error) throw error;
  res.json({ reel });
}

async function patchReel(req, res) {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id required' });
  const allowed = ['title', 'description', 'cover_url', 'status'];
  const patch = {};
  for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
  if (patch.status && !['draft', 'published', 'archived'].includes(patch.status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const { data, error } = await adminClient.from('reels').update(patch).eq('id', id).select().single();
  if (error) throw error;
  res.json({ reel: data });
}

async function deleteReel(req, res) {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id required' });
  const { data: assets } = await adminClient
    .from('reel_assets').select('id, s3_key, mux_asset_id').eq('reel_id', id);
  for (const a of assets || []) {
    await deleteAsset(a.mux_asset_id).catch(e => console.error('mux delete:', e.message));
    await deleteObject(a.s3_key).catch(e => console.error('storj delete:', e.message));
  }
  const { error } = await adminClient.from('reels').delete().eq('id', id);
  if (error) throw error;
  res.json({ ok: true });
}

async function presignUpload(req, res) {
  const { reel_id, filename, contentType } = req.body || {};
  if (!reel_id || !filename) return res.status(400).json({ error: 'reel_id and filename required' });
  const { data: reel } = await adminClient.from('reels').select('s3_prefix').eq('id', reel_id).single();
  if (!reel) return res.status(404).json({ error: 'Reel not found' });
  const safe = filename.replace(/[^a-zA-Z0-9._-]+/g, '_');
  const key = reel.s3_prefix + Date.now() + '-' + safe;
  const url = await presignPut(key, contentType || 'application/octet-stream');
  res.json({ url, key });
}

async function registerAsset(req, res) {
  const { reel_id, s3_key, title } = req.body || {};
  if (!reel_id || !s3_key) return res.status(400).json({ error: 'reel_id and s3_key required' });
  const inserted = await insertAsset(reel_id, s3_key, title);
  res.json({ asset: inserted });
}

async function insertAsset(reelId, s3_key, title) {
  const { data: maxRow } = await adminClient
    .from('reel_assets').select('sort_order').eq('reel_id', reelId)
    .order('sort_order', { ascending: false }).limit(1).maybeSingle();
  const sort_order = (maxRow?.sort_order ?? -1) + 1;

  const { data: row, error } = await adminClient
    .from('reel_assets')
    .insert({ reel_id: reelId, s3_key, title: title || null, sort_order, status: 'uploading' })
    .select().single();
  if (error) throw error;

  try {
    const presigned = await presignGet(s3_key);
    const asset = await createAssetFromUrl(presigned);
    await adminClient.from('reel_assets')
      .update({ mux_asset_id: asset.id, status: 'encoding' })
      .eq('id', row.id);
    row.mux_asset_id = asset.id;
    row.status = 'encoding';
  } catch (err) {
    console.error('Mux create failed for', s3_key, err.message);
    await adminClient.from('reel_assets').update({ status: 'error' }).eq('id', row.id);
    row.status = 'error';
  }
  return row;
}

async function patchAsset(req, res) {
  const { reel_id, asset_id } = req.body || {};
  if (!reel_id || !asset_id) return res.status(400).json({ error: 'reel_id and asset_id required' });
  const allowed = [
    'title', 'sort_order',
    'poster_url', 'poster_time',
    'poster_focal_x', 'poster_focal_y', 'poster_zoom',
  ];
  const patch = {};
  for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
  // Setting one poster source clears the other so they can't fight.
  if ('poster_url' in patch && patch.poster_url) patch.poster_time = null;
  if ('poster_time' in patch && patch.poster_time != null) patch.poster_url = null;
  // Picking a new source resets the crop transform unless one was supplied
  // alongside — fresh source media usually needs a fresh framing.
  const switchingSource = ('poster_url' in patch) || ('poster_time' in patch);
  if (switchingSource) {
    if (!('poster_focal_x' in patch)) patch.poster_focal_x = 50;
    if (!('poster_focal_y' in patch)) patch.poster_focal_y = 50;
    if (!('poster_zoom'    in patch)) patch.poster_zoom    = 1;
  }
  const { data, error } = await adminClient
    .from('reel_assets').update(patch)
    .eq('id', asset_id).eq('reel_id', reel_id).select().single();
  if (error) throw error;
  res.json({ asset: data });
}

async function deleteAssetRoute(req, res) {
  const { reel_id, asset_id } = req.body || {};
  if (!reel_id || !asset_id) return res.status(400).json({ error: 'reel_id and asset_id required' });
  const { data: a } = await adminClient
    .from('reel_assets').select('s3_key, mux_asset_id')
    .eq('id', asset_id).eq('reel_id', reel_id).single();
  if (!a) return res.status(404).json({ error: 'Asset not found' });
  await deleteAsset(a.mux_asset_id).catch(e => console.error('mux delete:', e.message));
  await deleteObject(a.s3_key).catch(e => console.error('storj delete:', e.message));
  await adminClient.from('reel_assets').delete().eq('id', asset_id);
  res.json({ ok: true });
}

async function syncReel(req, res) {
  const { reel_id } = req.body || {};
  if (!reel_id) return res.status(400).json({ error: 'reel_id required' });
  const { data: reel } = await adminClient.from('reels').select('id, s3_prefix').eq('id', reel_id).single();
  if (!reel) return res.status(404).json({ error: 'Reel not found' });
  const result = await reconcileReel(reel);
  res.json(result);
}

async function syncAll(req, res) {
  const root = await listPrefix(ROOT_PREFIX, '/');
  const discovered = [];

  for (const folder of root.folders) {
    const { data: existing } = await adminClient
      .from('reels').select('id').eq('s3_prefix', folder).maybeSingle();
    if (existing) continue;
    const folderName = folder.slice(ROOT_PREFIX.length).replace(/\/$/, '');
    if (!folderName) continue;
    const { data: created } = await adminClient
      .from('reels').insert({
        slug: slugId(),
        title: humanizeFolder(folderName),
        s3_prefix: folder,
        status: 'draft',
        auto_created: true,
      }).select('id, slug, title, s3_prefix').single();
    if (created) discovered.push(created);
  }

  const { data: reels } = await adminClient.from('reels').select('id, s3_prefix');
  const summaries = [];
  for (const reel of reels || []) {
    summaries.push({ reel_id: reel.id, ...(await reconcileReel(reel)) });
  }

  res.json({ root_prefix: ROOT_PREFIX, discovered, reels: summaries });
}

async function reconcileReel(reel) {
  const listed = await listPrefix(reel.s3_prefix);
  const liveKeys = new Set(listed.keys.filter(k => isVideoKey(k.key)).map(k => k.key));

  const { data: existing } = await adminClient
    .from('reel_assets').select('id, s3_key, status, mux_asset_id').eq('reel_id', reel.id);
  const knownKeys = new Set((existing || []).map(a => a.s3_key));

  const added = [];
  for (const key of liveKeys) {
    if (!knownKeys.has(key)) {
      const asset = await insertAsset(reel.id, key);
      added.push({ id: asset.id, s3_key: key });
    }
  }

  const removed = [];
  for (const a of existing || []) {
    if (!liveKeys.has(a.s3_key) && a.status !== 'archived') {
      await deleteAsset(a.mux_asset_id).catch(e => console.error('mux delete:', e.message));
      await adminClient.from('reel_assets')
        .update({ status: 'archived', mux_asset_id: null, mux_playback_id: null })
        .eq('id', a.id);
      removed.push(a.s3_key);
    }
  }

  return { added, removed };
}

async function resolvePoster(a) {
  if (a.poster_url) {
    try { return await presignGet(a.poster_url, 60 * 60 * 24); }
    catch (e) { console.error('poster presign failed', e.message); }
  }
  if (a.poster_time != null && a.mux_playback_id) {
    return `https://image.mux.com/${a.mux_playback_id}/thumbnail.jpg?width=1280&time=${a.poster_time}`;
  }
  if (a.mux_playback_id) {
    return `https://image.mux.com/${a.mux_playback_id}/thumbnail.jpg?width=1280`;
  }
  return null;
}

async function publicReel(req, res) {
  const slug = req.query.s;
  if (!slug) return res.status(400).json({ error: 's query param required' });
  const { data: reel, error } = await adminClient
    .from('public_reels_view').select('*').eq('slug', slug).maybeSingle();
  if (error) throw error;
  if (!reel) return res.status(404).json({ error: 'Not found' });
  const { data: rawAssets } = await adminClient
    .from('public_reel_assets_view').select('*').eq('reel_id', reel.id)
    .order('sort_order', { ascending: true });

  const assets = [];
  for (const a of rawAssets || []) {
    assets.push({
      id: a.id,
      reel_id: a.reel_id,
      mux_playback_id: a.mux_playback_id,
      title: a.title,
      sort_order: a.sort_order,
      duration_seconds: a.duration_seconds,
      poster: await resolvePoster(a),
      poster_focal_x: a.poster_focal_x,
      poster_focal_y: a.poster_focal_y,
      poster_zoom: a.poster_zoom,
    });
  }
  res.json({ reel, assets });
}

async function adminAssets(req, res) {
  const reelId = req.query.reel_id;
  if (!reelId) return res.status(400).json({ error: 'reel_id required' });
  // SELECT * so this endpoint keeps working before the poster-crop
  // migration is applied (poster_focal_x/_y/_zoom are added later and the
  // explicit column list would otherwise 500).
  const { data: rawAssets, error } = await adminClient
    .from('reel_assets')
    .select('*')
    .eq('reel_id', reelId)
    .order('sort_order', { ascending: true });
  if (error) throw error;

  const assets = [];
  for (const a of rawAssets || []) {
    assets.push({
      id: a.id,
      reel_id: a.reel_id,
      s3_key: a.s3_key,
      mux_playback_id: a.mux_playback_id,
      title: a.title,
      sort_order: a.sort_order,
      duration_seconds: a.duration_seconds,
      status: a.status,
      poster_url: a.poster_url,
      poster_time: a.poster_time,
      poster_focal_x: a.poster_focal_x,
      poster_focal_y: a.poster_focal_y,
      poster_zoom: a.poster_zoom,
      poster: await resolvePoster(a),
    });
  }
  res.json({ assets });
}
