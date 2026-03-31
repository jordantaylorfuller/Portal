const { adminClient } = require('../../lib/supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const email = 'jordantaylorfuller@gmail.com';

  const frontendOrigin = process.env.FRONTEND_ORIGIN || `https://${req.headers.host}`;

  const { data, error } = await adminClient.auth.admin.generateLink({
    type: 'magiclink',
    email,
    options: { redirectTo: frontendOrigin }
  });

  if (error) {
    console.error('Dev login error:', error.message);
    return res.status(500).json({ error: 'Failed to generate dev session' });
  }

  const url = new URL(data.properties.action_link);
  const tokenHash = url.searchParams.get('token');
  const type = url.searchParams.get('type');

  const { data: verified, error: verifyError } = await adminClient.auth.verifyOtp({
    token_hash: tokenHash,
    type: type || 'magiclink'
  });

  if (verifyError) {
    console.error('Dev login verify error:', verifyError.message);
    return res.status(500).json({ error: 'Failed to verify dev session' });
  }

  console.log('Dev login: signed in as', email);
  res.json({
    session: {
      access_token: verified.session.access_token,
      refresh_token: verified.session.refresh_token,
      expires_at: verified.session.expires_at,
      user: {
        id: verified.user.id,
        email: verified.user.email
      }
    }
  });
};
