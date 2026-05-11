const { requireProjectAccess } = require('../../../lib/auth');
const { adminClient } = require('../../../lib/supabase');
const fio = require('../../../lib/frameio');

const DELIVERABLES_FOLDER_NAME = '_DELIVERABLES';

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { projectId } = req.query;
  if (!(await requireProjectAccess(req, res, projectId))) return;

  // Manually-tracked deliveries (MASV uploads, Asana-synced rows, etc.).
  const { data: assets, error } = await adminClient
    .from('delivery_assets')
    .select('id, title, url, file_type, file_size, specs, group_name, status, direction, created_at')
    .eq('project_id', projectId)
    .order('group_name')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Deliveries fetch error:', error.message);
    return res.status(500).json({ error: 'Failed to fetch deliveries' });
  }

  // Frame.io _DELIVERABLES folder. Linked projects expose their final
  // outputs under a convention-named subfolder; surface those files as a
  // group in the delivery room so clients don't have to log into Frame.io
  // to download them. Insert this group FIRST so it renders at the top of
  // the delivery room (object key order = insertion order). Failures here
  // are swallowed so a Frame.io outage can't take out the manual
  // deliveries list.
  const groups = {};
  let frameioGroup = null;
  try {
    frameioGroup = await fetchFrameioDeliverables(projectId);
  } catch (err) {
    console.error('Frame.io _DELIVERABLES fetch failed for', projectId, err.message);
  }
  if (frameioGroup && frameioGroup.length) {
    groups[DELIVERABLES_FOLDER_NAME] = frameioGroup;
  }

  for (const asset of (assets || [])) {
    const g = asset.group_name || 'Files';
    if (!groups[g]) groups[g] = [];
    groups[g].push(asset);
  }

  res.json({
    project_id: projectId,
    groups,
    total: Object.values(groups).reduce((n, list) => n + list.length, 0)
  });
};

async function fetchFrameioDeliverables(portalProjectId) {
  const { data: project } = await adminClient
    .from('projects')
    .select('id, frameio_account_id, frameio_project_id, frameio_root_folder_id')
    .eq('id', portalProjectId)
    .single();
  if (!project || !project.frameio_project_id) return null;

  // Resolve account + root folder if not cached. Mirrors sync.js so the
  // delivery room works the first time a project is opened, before any
  // admin sync has populated frameio_root_folder_id.
  let accountId = project.frameio_account_id;
  let rootFolderId = project.frameio_root_folder_id;
  if (!accountId || !rootFolderId) {
    if (!accountId) {
      const me = await fio.getMe();
      accountId = me && me.account_id;
      if (!accountId) return null;
    }
    const fp = await fio.getProject(accountId, project.frameio_project_id);
    if (!fp) return null;
    rootFolderId = fp.root_folder_id || (fp.root_folder && fp.root_folder.id) || null;
    if (!rootFolderId) return null;
    await adminClient.from('projects')
      .update({ frameio_account_id: accountId, frameio_root_folder_id: rootFolderId })
      .eq('id', portalProjectId);
  }

  const folder = await fio.findChildFolderByName(accountId, rootFolderId, DELIVERABLES_FOLDER_NAME);
  if (!folder) return null;

  const children = await fio.listFolderChildren(accountId, folder.id);
  // Frame.io has shipped both `type` and `_type` discriminators across API
  // versions; normalise once so the version_stack resolver below sees the
  // same value the filter used. Otherwise a payload carrying only `_type`
  // would pass the filter (via the OR fallback) but skip the head-version
  // resolution and surface as a download with no working URL.
  const typedFiles = children
    .map(c => ({ child: c, type: ((c.type || c._type) || '').toLowerCase() }))
    .filter(x => x.type === 'file' || x.type === 'version_stack');
  if (!typedFiles.length) return [];

  // Resolve a download URL per file. version_stacks hand back the head
  // version; getFile with media_links.original gets us a signed
  // direct-download URL we can hand to the client without a Frame.io login.
  const items = await Promise.all(typedFiles.map(async ({ child, type }) => {
    let headFileId = child.id;
    if (type === 'version_stack') {
      try {
        const stack = await fio.getVersionStack(accountId, child.id);
        if (stack && stack.head_version && stack.head_version.id) {
          headFileId = stack.head_version.id;
        }
      } catch (err) {
        console.error('getVersionStack failed for', child.id, err.message);
      }
    }

    let file = child;
    try {
      const full = await fio.getFile(accountId, headFileId, { include: 'media_links.original' });
      if (full) file = full;
    } catch (err) {
      console.error('getFile failed for', headFileId, err.message);
    }

    const original = file.media_links && file.media_links.original;
    const url = (original && (original.download_url || original.url)) || null;
    if (!url) return null;
    const fileSize = typeof file.file_size === 'number' ? formatFileSize(file.file_size) : null;

    return {
      id: child.id,
      title: file.name || child.name || 'Untitled',
      url,
      file_type: file.media_type || null,
      file_size: fileSize,
      specs: null,
      group_name: DELIVERABLES_FOLDER_NAME,
      status: 'ready',
      direction: 'studio_to_client',
      created_at: file.created_at || child.created_at || null
    };
  }));

  // Drop files we couldn't resolve a URL for — the existing UI renders a
  // Download button for any row regardless of url, and our empty-string
  // fallback would hand the client a zero-byte placeholder. They'll show
  // up on the next page load once Frame.io finishes processing.
  return items.filter(Boolean);
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}
