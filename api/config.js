// Public client config. Surfaces non-secret runtime values that the static index.html
// would otherwise have to hardcode (and that should differ between preview/prod).
module.exports = function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.json({
    masvPortalUrl: process.env.MASV_PORTAL_URL || ''
  });
};
