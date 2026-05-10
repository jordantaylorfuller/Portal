// Adobe redirects here after the user authorizes. We verify the signed
// state, exchange the code for tokens, and persist the refresh token in
// Supabase. Then redirect to /admin/frameio with a success/error flag.

const crypto = require('crypto');
const { exchangeCode } = require('../../../lib/frameio');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { code, state, error, error_description } = req.query || {};

  if (error) {
    return redirectAdmin(res, { error: `Adobe: ${error_description || error}` });
  }
  if (!code || !state) {
    return redirectAdmin(res, { error: 'Missing code or state' });
  }
  if (!verifyState(String(state))) {
    return redirectAdmin(res, { error: 'Invalid or expired state' });
  }

  const redirectUri = computeRedirectUri(req);
  try {
    const me = await exchangeCode({ code: String(code), redirectUri });
    return redirectAdmin(res, {
      success: '1',
      email: me && me.email ? me.email : '',
      account_id: me && me.account_id ? me.account_id : ''
    });
  } catch (err) {
    console.error('Frame.io OAuth exchange error:', err.message);
    return redirectAdmin(res, { error: err.message });
  }
};

function computeRedirectUri(req) {
  if (process.env.FRAMEIO_REDIRECT_URI) return process.env.FRAMEIO_REDIRECT_URI;
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}/api/frameio/auth/callback`;
}

function verifyState(state) {
  const dot = state.lastIndexOf('.');
  if (dot < 0) return false;
  const data = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = crypto
    .createHmac('sha256', process.env.SUPABASE_SERVICE_ROLE_KEY || 'dev')
    .update(data)
    .digest('base64url');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(sig, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  let payload;
  try { payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')); }
  catch { return false; }
  if (!payload || typeof payload.expiresAt !== 'number') return false;
  if (Date.now() > payload.expiresAt) return false;
  return true;
}

function redirectAdmin(res, params) {
  const qs = new URLSearchParams(params).toString();
  res.statusCode = 302;
  res.setHeader('Location', `/admin-frameio.html?${qs}`);
  res.end();
}
