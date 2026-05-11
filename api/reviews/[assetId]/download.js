// GET /api/reviews/{assetId}/download
// Returns a fresh signed Frame.io download URL for the asset's original file.
//
// Strategy: fetch on demand rather than serving from review_assets storage.
// Frame.io's signed URLs expire (~22d at issue time) and we want any "download"
// click to resolve to a URL that's good NOW, not stale from the last sync.

const { requireProjectAccess } = require('../../../lib/auth');
const { adminClient } = require('../../../lib/supabase');
const fio = require('../../../lib/frameio');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { assetId } = req.query;
  if (!assetId) return res.status(400).json({ error: 'assetId required' });

  // Look up the asset → resolve the portal project + Frame.io ids we need.
  // For version_stacks, frameio_asset_id is the stack id (which Frame.io's
  // /files/:id endpoint rejects); the head_version's file id is in
  // frameio_head_file_id. Fall back to frameio_asset_id for legacy rows.
  const { data: asset, error: assetErr } = await adminClient
    .from('review_assets')
    .select('id, project_id, title, frameio_asset_id, frameio_head_file_id')
    .eq('id', assetId)
    .maybeSingle();

  if (assetErr) {
    console.error('Asset lookup error:', assetErr.message);
    return res.status(500).json({ error: 'Failed to load asset' });
  }
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  const downloadFileId = asset.frameio_head_file_id || asset.frameio_asset_id;
  if (!downloadFileId) {
    return res.status(409).json({ error: 'Asset is not linked to Frame.io' });
  }

  // Project-level access check (handles admin override + archived gating).
  const access = await requireProjectAccess(req, res, asset.project_id);
  if (!access) return; // requireProjectAccess wrote the response.

  // Need the Frame.io account_id for the v4 URL. It's cached on the project row.
  const { data: project } = await adminClient
    .from('projects')
    .select('frameio_account_id')
    .eq('id', asset.project_id)
    .maybeSingle();

  let accountId = project && project.frameio_account_id;
  if (!accountId) {
    try {
      const me = await fio.getMe();
      accountId = me && me.account_id;
    } catch (err) {
      console.error('Frame.io /me lookup failed:', err.message);
    }
  }
  if (!accountId) return res.status(500).json({ error: 'Frame.io account not resolved' });

  // Pull a fresh media_links.original download_url. Falls back to inline_url
  // if download_url is missing for some reason (shouldn't happen for v4 files).
  try {
    const file = await fio.getFile(accountId, downloadFileId, {
      include: 'media_links.original'
    });
    const original = file && file.media_links && file.media_links.original;
    const url = (original && (original.download_url || original.inline_url)) || null;
    if (!url) {
      return res.status(502).json({ error: 'No download URL returned by Frame.io' });
    }
    return res.json({ url, filename: asset.title || null });
  } catch (err) {
    console.error('Frame.io download URL fetch failed:', err.message);
    return res.status(502).json({ error: 'Could not retrieve download URL' });
  }
};
