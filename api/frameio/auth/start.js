// Initiates the Frame.io OAuth flow. Caller must be an authenticated admin
// (user_profiles.role = 'admin'). Returns { authorize_url } — the browser
// then navigates there. We sign a short-lived `state` so the callback can
// verify the request originated from us (CSRF guard) without needing a
// state-storage table.

const crypto = require('crypto');
const { getAuthUser } = require('../../../lib/auth');
const { adminClient } = require('../../../lib/supabase');
const { buildAuthorizeUrl } = require('../../../lib/frameio');
const { isAdmin } = require('../../../lib/admin');

const STATE_TTL_MS = 10 * 60 * 1000;

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await getAuthUser(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const { data: profile } = await adminClient
    .from('user_profiles').select('role').eq('id', auth.id).maybeSingle();
  if (!isAdmin(profile, auth.email)) {
    return res.status(403).json({ error: 'Admin only' });
  }

  const redirectUri = computeRedirectUri(req);
  const state = signState({ userId: auth.id, expiresAt: Date.now() + STATE_TTL_MS });
  const authorize_url = buildAuthorizeUrl({ redirectUri, state });

  return res.json({ authorize_url, redirect_uri: redirectUri });
};

function computeRedirectUri(req) {
  if (process.env.FRAMEIO_REDIRECT_URI) return process.env.FRAMEIO_REDIRECT_URI;
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}/api/frameio/auth/callback`;
}

function signState(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', process.env.SUPABASE_SERVICE_ROLE_KEY || 'dev')
    .update(data)
    .digest('base64url');
  return `${data}.${sig}`;
}
