// Resolve the user-facing origin for redirectTo / invite URLs.
// Selection rules:
//   - production:  pin to FRONTEND_ORIGIN (stable user-facing domain).
//   - preview:     use VERCEL_URL (the per-deployment preview URL) so links
//                  exercise the deployment that generated them, not prod.
//   - local dev:   use req.headers.host with http:// (vercel dev sets
//                  VERCEL_URL=localhost:<port> and x-forwarded-proto=https,
//                  both of which would produce broken URLs here).

function isLocalHost(h) {
  return /^localhost(:|$)|^127\.0\.0\.1(:|$)/.test(h || '');
}

function resolveFrontendOrigin(req) {
  if (process.env.VERCEL_ENV === 'production') {
    return process.env.FRONTEND_ORIGIN ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `https://${req.headers.host}`);
  }
  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl && !isLocalHost(vercelUrl)) {
    return `https://${vercelUrl}`;
  }
  const host = req.headers.host || 'localhost';
  const proto = isLocalHost(host)
    ? 'http'
    : String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  return `${proto}://${host}`;
}

module.exports = { resolveFrontendOrigin };
