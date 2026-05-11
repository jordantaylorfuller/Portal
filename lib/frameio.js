// Frame.io v4 client.
// Auth: Adobe IMS OAuth Web App (3-legged) with offline_access refresh token.
// Token endpoint: https://ims-na1.adobelogin.com/ims/token/v3
// API base:       https://api.frame.io/v4
// Webhooks:       v0:{ts}:{body} HMAC-SHA256 with per-webhook secret.

const crypto = require('crypto');
const { adminClient } = require('./supabase');

const IMS_AUTHORIZE_URL = 'https://ims-na1.adobelogin.com/ims/authorize/v2';
const IMS_TOKEN_URL     = 'https://ims-na1.adobelogin.com/ims/token/v3';
const API_BASE          = 'https://api.frame.io/v4';
const TOKEN_NAME        = 'default';

// Adobe's docs and the frameio-kit defaults for User auth scopes.
// `offline_access` is what gets us a refresh token.
const SCOPES = ['openid', 'AdobeID', 'profile', 'email', 'offline_access', 'additional_info.roles'];

const REFRESH_BUFFER_MS = 60 * 1000; // refresh 60s before access-token expiry

// In-process cache. Populated from DB on first call; kept fresh after rotations.
let _cache = null; // { access_token, access_expires_at: Date, refresh_token }

// ---------------------------------------------------------------------------
// OAuth: build authorize URL (used by /api/frameio/auth/start)
// ---------------------------------------------------------------------------
function buildAuthorizeUrl({ redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: requireEnv('FRAMEIO_CLIENT_ID'),
    scope: SCOPES.join(' '),
    response_type: 'code',
    redirect_uri: redirectUri,
    state
  });
  return `${IMS_AUTHORIZE_URL}?${params.toString()}`;
}

// Exchange the authorization code (from the redirect callback) for tokens.
// Persists the refresh token + access token in Supabase. Returns the user info.
async function exchangeCode({ code, redirectUri }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: requireEnv('FRAMEIO_CLIENT_ID'),
    client_secret: requireEnv('FRAMEIO_CLIENT_SECRET'),
    code,
    redirect_uri: redirectUri
  });

  const res = await fetch(IMS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`IMS token exchange failed: ${res.status} ${JSON.stringify(json)}`);
  }
  if (!json.refresh_token) {
    throw new Error('IMS response missing refresh_token (offline_access scope not granted?)');
  }

  const accessExpiresAt = new Date(Date.now() + (json.expires_in || 3600) * 1000);

  // Pull /v4/me + /v4/accounts. On Pro accounts /v4/me does NOT include
  // account_id; you have to list the user's accounts separately and pick
  // one. We pick the first (and typically only) account.
  let userData = {};
  let accountId = null;
  try {
    const me = await rawApi('/me', { accessToken: json.access_token });
    userData = (me && me.data) || {};
  } catch (err) {
    console.error('Frame.io /me lookup after exchange failed:', err.message);
  }
  try {
    const accs = await rawApi('/accounts', { accessToken: json.access_token });
    const accounts = (accs && accs.data) || [];
    if (accounts.length > 0) accountId = accounts[0].id;
  } catch (err) {
    console.error('Frame.io /accounts lookup after exchange failed:', err.message);
  }

  await adminClient.from('frameio_tokens').upsert({
    name: TOKEN_NAME,
    refresh_token: json.refresh_token,
    access_token: json.access_token,
    access_expires_at: accessExpiresAt.toISOString(),
    account_id: accountId,
    user_email: userData.email || null,
    scopes: json.scope || SCOPES.join(' '),
    updated_at: new Date().toISOString()
  }, { onConflict: 'name' });

  _cache = {
    access_token: json.access_token,
    access_expires_at: accessExpiresAt,
    refresh_token: json.refresh_token
  };

  return {
    account_id: accountId,
    email: userData.email || null,
    name: userData.name || null
  };
}

// Get a valid access token, refreshing if needed. Handles rotation.
async function getAccessToken() {
  if (_cache && _cache.access_token && _cache.access_expires_at &&
      _cache.access_expires_at.getTime() - Date.now() > REFRESH_BUFFER_MS) {
    return _cache.access_token;
  }

  // Load from DB.
  const { data: row, error } = await adminClient
    .from('frameio_tokens').select('*').eq('name', TOKEN_NAME).single();
  if (error || !row) {
    throw new Error('Frame.io is not connected — visit /api/frameio/auth/start to sign in.');
  }

  const dbExpiresAt = row.access_expires_at ? new Date(row.access_expires_at) : null;
  if (row.access_token && dbExpiresAt &&
      dbExpiresAt.getTime() - Date.now() > REFRESH_BUFFER_MS) {
    _cache = {
      access_token: row.access_token,
      access_expires_at: dbExpiresAt,
      refresh_token: row.refresh_token
    };
    return row.access_token;
  }

  // Refresh.
  return refreshAccessToken(row.refresh_token);
}

async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: requireEnv('FRAMEIO_CLIENT_ID'),
    client_secret: requireEnv('FRAMEIO_CLIENT_SECRET'),
    refresh_token: refreshToken
  });

  const res = await fetch(IMS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (json && json.error === 'invalid_grant') {
      // Refresh chain broken — needs re-auth.
      throw new Error('Frame.io refresh token rejected (invalid_grant). Re-authorize at /api/frameio/auth/start.');
    }
    throw new Error(`IMS refresh failed: ${res.status} ${JSON.stringify(json)}`);
  }

  const newRefresh = json.refresh_token || refreshToken;
  const accessExpiresAt = new Date(Date.now() + (json.expires_in || 3600) * 1000);

  await adminClient.from('frameio_tokens').update({
    refresh_token: newRefresh,
    access_token: json.access_token,
    access_expires_at: accessExpiresAt.toISOString(),
    updated_at: new Date().toISOString()
  }).eq('name', TOKEN_NAME);

  _cache = {
    access_token: json.access_token,
    access_expires_at: accessExpiresAt,
    refresh_token: newRefresh
  };
  return json.access_token;
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------
async function api(path, opts = {}) {
  const token = await getAccessToken();
  return rawApi(path, { ...opts, accessToken: token });
}

async function rawApi(path, { method = 'GET', accessToken, body, query } = {}) {
  let url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    url += (url.includes('?') ? '&' : '?') + qs;
  }
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json'
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  // Retry on 429 with linear backoff. Frame.io's rate limits are tight on the
  // free tier; the per-file metadata fetches in sync.js bump up against them
  // and a single retry typically clears it.
  const MAX_429_RETRIES = 3;
  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    if (res.status === 429 && attempt < MAX_429_RETRIES) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : (attempt + 1) * 1500;
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }
    const text = await res.text();
    const json = text ? safeJsonParse(text) : null;
    if (!res.ok) {
      const detail = json ? JSON.stringify(json) : text.slice(0, 500);
      const err = new Error(`Frame.io ${method} ${path} → ${res.status}: ${detail}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }
  // Unreachable; loop either returns or throws.
}

function safeJsonParse(s) { try { return JSON.parse(s); } catch { return null; } }

// Walk a paginated list endpoint, following `links.next` cursors.
// Re-applies the original query params on each follow-up request because
// Frame.io's cursor link strips them.
async function paginate(path, query = {}) {
  const results = [];
  let cursor = null;
  for (let i = 0; i < 50; i++) { // safety cap
    const q = { ...query };
    if (cursor) q.after = cursor;
    const page = await api(path, { query: q });
    if (page && Array.isArray(page.data)) results.push(...page.data);
    cursor = page && page.links && page.links.next_cursor;
    if (!cursor) {
      // Some endpoints return links.next as a URL with `after=...`; parse it.
      const nextUrl = page && page.links && page.links.next;
      if (nextUrl) {
        const m = String(nextUrl).match(/[?&]after=([^&]+)/);
        cursor = m ? decodeURIComponent(m[1]) : null;
      }
    }
    if (!cursor) break;
  }
  return results;
}

// ---------------------------------------------------------------------------
// High-level helpers used by sync + admin endpoints.
// ---------------------------------------------------------------------------
async function getMe() {
  // /v4/me returns user info but no account_id; fetch /accounts in parallel
  // and merge the first account's id onto the result.
  const [me, accs] = await Promise.all([
    api('/me'),
    api('/accounts').catch(() => null)
  ]);
  const user = (me && me.data) || {};
  const accounts = (accs && accs.data) || [];
  if (accounts.length > 0 && !user.account_id) {
    user.account_id = accounts[0].id;
    user.account_name = accounts[0].display_name || accounts[0].name;
  }
  user.accounts = accounts;
  return user;
}

async function listAccounts() {
  const r = await api('/accounts');
  return (r && r.data) || [];
}

async function listWorkspaces(accountId) {
  return paginate(`/accounts/${accountId}/workspaces`, { page_size: 50 });
}

async function listProjects(accountId, workspaceId) {
  return paginate(`/accounts/${accountId}/workspaces/${workspaceId}/projects`, { page_size: 100 });
}

// Discover every project across every workspace in the connected account.
// Each item is annotated with its workspace_id for upserting.
async function listAllProjects(accountId) {
  const workspaces = await listWorkspaces(accountId);
  const all = [];
  for (const ws of workspaces) {
    const projects = await listProjects(accountId, ws.id);
    for (const p of projects) {
      all.push({ ...p, workspace_id: ws.id });
    }
  }
  return all;
}

// Strip the studio's "#NNNN_" project-code prefix for display. If a name
// doesn't match the convention, return it unchanged.
//   "#2501_JACQUEMUS" → "JACQUEMUS"
//   "#0000_REELS"     → "REELS"
//   "xxxTRAILER"      → "xxxTRAILER"
//   "ZZZ_SEAN"        → "ZZZ_SEAN"
function stripProjectPrefix(name) {
  if (!name) return name;
  return name.replace(/^#\w+_/, '');
}

async function getProject(accountId, projectId) {
  const r = await api(`/accounts/${accountId}/projects/${projectId}`);
  return r && r.data ? r.data : null;
}

async function listFolderChildren(accountId, folderId, opts = {}) {
  return paginate(`/accounts/${accountId}/folders/${folderId}/children`, {
    page_size: 50,
    include: 'metadata',
    ...opts
  });
}

async function getFile(accountId, fileId, { include = 'metadata' } = {}) {
  const r = await api(`/accounts/${accountId}/files/${fileId}`, {
    query: { include }
  });
  return r && r.data ? r.data : null;
}

// Frame.io v4 returns `metadata` as an array of typed field objects rather
// than a key-value map: each entry has { field_definition_name, value, ... }.
// This helper pulls a value out by its human-readable definition name.
//   readFileMetadata(file, 'Comment Count') → 3
//   readFileMetadata(file, 'Date Uploaded') → "2026-03-03T15:09:55Z"
function readFileMetadata(file, name) {
  if (!file || !Array.isArray(file.metadata)) return null;
  const entry = file.metadata.find(m => m && m.field_definition_name === name);
  if (!entry) return null;
  return entry.value != null ? entry.value : null;
}

async function listFileComments(accountId, fileId) {
  return paginate(`/accounts/${accountId}/files/${fileId}/comments`, { page_size: 100 });
}

// Frame.io v4 version_stack: a folder-like container that holds multiple
// uploaded versions of the same asset. The response embeds `head_version`,
// a full file object representing the latest version. Use that for media
// (thumb, duration, download URL); use the stack id as the row's stable
// identity so version uploads don't churn frameio_asset_id.
async function getVersionStack(accountId, stackId) {
  const r = await api(`/accounts/${accountId}/version_stacks/${stackId}`);
  return r && r.data ? r.data : null;
}

// v4 share create: type is the discriminator and the only valid value is
// "asset". access defaults to public. asset_ids attaches files/folders in
// the same call — no separate add-asset call needed.
async function createShare(accountId, projectId, { name, assetIds, access = 'public', downloadingEnabled = true } = {}) {
  const ids = Array.isArray(assetIds) ? assetIds : (assetIds ? [assetIds] : []);
  const r = await api(`/accounts/${accountId}/projects/${projectId}/shares`, {
    method: 'POST',
    body: {
      data: {
        type: 'asset',
        access,
        name: name || 'Portal Share',
        asset_ids: ids,
        downloading_enabled: downloadingEnabled
      }
    }
  });
  return r && r.data ? r.data : null;
}

async function addAssetToShare(accountId, shareId, assetIds) {
  const ids = Array.isArray(assetIds) ? assetIds : [assetIds];
  const r = await api(`/accounts/${accountId}/shares/${shareId}/assets`, {
    method: 'POST',
    body: { asset_ids: ids }
  });
  return r && r.data ? r.data : null;
}

async function getShare(accountId, shareId) {
  const r = await api(`/accounts/${accountId}/shares/${shareId}`);
  return r && r.data ? r.data : null;
}

// ---------------------------------------------------------------------------
// Webhook signature verification — Frame.io spec:
// X-Frameio-Request-Timestamp: <epoch_seconds>
// X-Frameio-Signature:         v0=<hex_hmac_sha256>
// message:                     v0:<ts>:<raw_body>
// HMAC-SHA256 with per-webhook signing secret. ~5 min replay window.
// ---------------------------------------------------------------------------
function verifyWebhookSignature(rawBody, headers, secret = process.env.FRAMEIO_WEBHOOK_SECRET) {
  if (!secret) return false;
  const ts  = headers['x-frameio-request-timestamp'];
  const sig = headers['x-frameio-signature'];
  if (!ts || !sig) return false;
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;
  const skewSec = Math.abs(Date.now() / 1000 - tsNum);
  if (skewSec > 300) return false;

  const expected = 'v0=' + crypto.createHmac('sha256', secret)
    .update(`v0:${ts}:${rawBody}`)
    .digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(sig), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Status mapping. v4 stores status as a metadata custom field with
// human-readable labels. Default option set from Frame.io is the legacy three;
// we keep raw label in frameio_status_raw for anything unmapped.
// ---------------------------------------------------------------------------
const STATUS_MAP = {
  'approved':     'approved',
  'in progress':  'in_review',
  'in_progress':  'in_review',
  'needs review': 'needs_review',
  'needs_review': 'needs_review',
  'none':         'needs_review',
  '':             'needs_review',
  null:           'needs_review'
};

function mapStatus(rawLabel) {
  if (rawLabel == null) return 'needs_review';
  const k = String(rawLabel).trim().toLowerCase();
  return STATUS_MAP[k] || 'needs_review';
}

// Pull a `status` value out of a file's metadata payload. Frame.io's metadata
// shape varies by API version; we look in a few likely places.
function readStatusFromFile(file) {
  if (!file) return { mapped: 'needs_review', raw: null };
  const meta = file.metadata || file.fields || {};
  const candidates = [
    meta.status,
    meta.Status,
    file.status_label,
    file.label
  ];
  for (const c of candidates) {
    if (c == null) continue;
    if (typeof c === 'string') return { mapped: mapStatus(c), raw: c };
    if (typeof c === 'object' && (c.value || c.name || c.label)) {
      const raw = c.value || c.name || c.label;
      return { mapped: mapStatus(raw), raw };
    }
  }
  return { mapped: 'needs_review', raw: null };
}

// ---------------------------------------------------------------------------
function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

module.exports = {
  // OAuth
  buildAuthorizeUrl,
  exchangeCode,
  getAccessToken,
  // API
  api,
  paginate,
  getMe,
  listAccounts,
  listWorkspaces,
  listProjects,
  listAllProjects,
  stripProjectPrefix,
  getProject,
  getFile,
  readFileMetadata,
  listFolderChildren,
  listFileComments,
  getVersionStack,
  createShare,
  addAssetToShare,
  getShare,
  // Webhook
  verifyWebhookSignature,
  // Status
  mapStatus,
  readStatusFromFile,
  // Constants
  SCOPES
};
