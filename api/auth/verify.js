const { adminClient } = require('../../lib/supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { token_hash, type } = req.body;
  if (!token_hash || !type) {
    return res.status(400).json({ error: 'token_hash and type are required' });
  }

  const { data, error } = await adminClient.auth.verifyOtp({ token_hash, type });

  if (error) {
    console.error('Verify OTP error:', error.message);
    return res.status(400).json({ error: 'Invalid or expired link' });
  }

  res.json({
    session: {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at,
      user: {
        id: data.user.id,
        email: data.user.email
      }
    }
  });
};
