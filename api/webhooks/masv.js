const crypto = require('crypto');
const { adminClient } = require('../../lib/supabase');

const MASV_API_BASE = 'https://api.massive.app/v1';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // MASV doesn't sign webhook payloads; the documented pattern is a static custom header
  // attached when the webhook is created. We require it before doing any work.
  const expected = process.env.MASV_WEBHOOK_SECRET;
  const provided = req.headers['x-masv-secret'];
  if (!expected) {
    console.error('MASV webhook called but MASV_WEBHOOK_SECRET is not configured');
    return res.status(503).end();
  }
  if (!provided || !timingSafeEqualStrings(provided, expected)) {
    console.error('MASV webhook auth failed');
    return res.status(401).end();
  }

  const event = req.body || {};
  if (event.event_type !== 'package.finalized') {
    console.log(`MASV webhook: ignoring event_type=${event.event_type}`);
    return res.status(200).end();
  }

  try {
    await handlePackageFinalized(event);
  } catch (err) {
    console.error('MASV webhook handler error:', err.message);
    // Return 200 so MASV doesn't churn its retry queue on bugs we'd rather see in logs.
    return res.status(200).end();
  }

  res.status(200).end();
};

function timingSafeEqualStrings(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

async function handlePackageFinalized(event) {
  const pkg = event.object || {};
  if (!pkg.id) {
    console.warn('MASV webhook: package.finalized with no object.id, ignoring');
    return;
  }

  // Resolve project_id from the form response (custom_metadata_id).
  // The Portal's custom form must have a field with key/name "project_id".
  const projectId = await resolveProjectId(pkg);
  if (!projectId) {
    console.warn(`MASV webhook: could not resolve project_id for package ${pkg.id}; skipping insert`);
    return;
  }

  const { data: project } = await adminClient
    .from('projects')
    .select('id, name')
    .eq('id', projectId)
    .single();
  if (!project) {
    console.warn(`MASV webhook: project_id ${projectId} not in DB; skipping insert`);
    return;
  }

  const uploaderUserId = await resolveUploaderUserId(pkg.sender);

  const portalUrl = process.env.MASV_PORTAL_URL || '';
  const fileSize = pkg.size ? humanizeBytes(pkg.size) : null;
  const titleBase = pkg.name || 'Client upload';
  const fileCount = pkg.total_files || 0;
  const title = fileCount > 1 ? `${titleBase} (${fileCount} files)` : titleBase;

  const { error } = await adminClient
    .from('delivery_assets')
    .upsert({
      project_id: project.id,
      masv_package_id: pkg.id,
      uploader_user_id: uploaderUserId,
      direction: 'client_to_studio',
      title,
      // No per-package download URL is delivered in the payload — MASV emails the studio
      // a download link separately. The portal URL is stored as a non-null placeholder so
      // the existing schema constraint holds; the renderer hides the Download button for
      // direction='client_to_studio' rows.
      url: portalUrl || 'https://massive.io',
      file_type: 'upload',
      file_size: fileSize,
      group_name: 'Sent by you',
      status: 'ready',
      updated_at: new Date().toISOString()
    }, { onConflict: 'masv_package_id' });

  if (error) {
    console.error('MASV delivery_assets upsert error:', error.message);
    return;
  }

  console.log(`MASV upload recorded: package ${pkg.id} -> project ${project.name} (${project.id})`);
  await notifyStudio(project, pkg);
}

async function resolveProjectId(pkg) {
  // The package object references its form response via form_data_id. The form values
  // themselves are read with GET /v1/packages/{package_id}/metadata (per MASV docs).
  // We use the package id directly rather than navigating form_data_id, since the
  // metadata endpoint is keyed on package id.
  const hasForm = pkg.form_data_id || pkg.custom_metadata_id;
  if (!hasForm) return null;

  const apiKey = process.env.MASV_API_KEY;
  if (!apiKey) {
    console.error('MASV_API_KEY not set; cannot resolve form data');
    return null;
  }

  try {
    const resp = await fetch(`${MASV_API_BASE}/packages/${pkg.id}/metadata`, {
      headers: { 'X-API-KEY': apiKey }
    });
    if (!resp.ok) {
      console.warn(`MASV webhook: package metadata fetch returned ${resp.status} for ${pkg.id}`);
      return null;
    }
    const data = await resp.json();
    return extractProjectIdFromFormData(data);
  } catch (err) {
    console.warn(`MASV webhook: package metadata fetch failed for ${pkg.id}: ${err.message}`);
    return null;
  }
}

function extractProjectIdFromFormData(data) {
  if (!data || typeof data !== 'object') return null;
  // Tolerate a few likely shapes since the read response isn't documented:
  //   { fields: { project_id: { value: '<uuid>' } } }
  //   { project_id: '<uuid>' }
  //   { responses: [{ name: 'project_id', value: '<uuid>' }] }
  if (data.project_id && isUuid(data.project_id)) return data.project_id;
  if (data.fields && data.fields.project_id) {
    const v = data.fields.project_id.value || data.fields.project_id;
    if (isUuid(v)) return v;
  }
  if (Array.isArray(data.responses)) {
    const f = data.responses.find(r => r && (r.name === 'project_id' || r.key === 'project_id'));
    if (f && isUuid(f.value)) return f.value;
  }
  if (Array.isArray(data.fields)) {
    const f = data.fields.find(r => r && (r.name === 'project_id' || r.key === 'project_id'));
    if (f && isUuid(f.value)) return f.value;
  }
  return null;
}

function isUuid(s) {
  return typeof s === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

async function resolveUploaderUserId(senderEmail) {
  if (!senderEmail) return null;
  try {
    const { data } = await adminClient.auth.admin.listUsers();
    const match = (data && data.users || []).find(u => u.email && u.email.toLowerCase() === senderEmail.toLowerCase());
    return match ? match.id : null;
  } catch (err) {
    console.warn('MASV webhook: uploader lookup failed:', err.message);
    return null;
  }
}

function humanizeBytes(bytes) {
  if (!bytes || bytes < 0) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  const rounded = n >= 100 ? Math.round(n) : Math.round(n * 10) / 10;
  return `${rounded} ${units[i]}`;
}

async function notifyStudio(project, pkg) {
  const apiKey = process.env.RESEND_API_KEY;
  const studioInbox = process.env.NIPC_HOST_EMAIL;
  if (!apiKey || !studioInbox) {
    console.log('MASV webhook: studio notification skipped (RESEND_API_KEY or NIPC_HOST_EMAIL missing)');
    return;
  }
  try {
    const subject = `New client upload: ${project.name}`;
    const html =
      `<p>A client just uploaded a file via MASV.</p>` +
      `<ul>` +
      `<li><b>Project:</b> ${escapeHtml(project.name)}</li>` +
      `<li><b>From:</b> ${escapeHtml(pkg.sender || 'unknown sender')}</li>` +
      `<li><b>Package:</b> ${escapeHtml(pkg.name || pkg.id)}</li>` +
      (pkg.total_files ? `<li><b>Files:</b> ${pkg.total_files}</li>` : '') +
      (pkg.size ? `<li><b>Size:</b> ${humanizeBytes(pkg.size)}</li>` : '') +
      `</ul>` +
      `<p>Download link will arrive in MASV's standard notification email.</p>`;

    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'NIPC Portal <portal@nipc.tv>',
        to: [studioInbox],
        subject,
        html
      })
    });
    if (!resp.ok) {
      const text = await resp.text();
      console.warn('MASV studio notify: resend non-200', resp.status, text);
    }
  } catch (err) {
    console.warn('MASV studio notify failed:', err.message);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
