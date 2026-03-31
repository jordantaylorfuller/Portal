const { adminClient } = require('../../lib/supabase');

const DEV_EMAIL = 'jordantaylorfuller@gmail.com';
const DEV_PASSWORD = 'dev-login-portal-2026';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Ensure the dev user has a password set (idempotent)
  const { data: { users } } = await adminClient.auth.admin.listUsers();
  const devUser = users.find(u => u.email === DEV_EMAIL);
  if (!devUser) return res.status(500).json({ error: 'Dev user not found' });

  await adminClient.auth.admin.updateUserById(devUser.id, { password: DEV_PASSWORD });

  // Sign in with password to get a real session
  const { data, error } = await adminClient.auth.signInWithPassword({
    email: DEV_EMAIL,
    password: DEV_PASSWORD
  });

  if (error) {
    console.error('Dev login error:', error.message);
    return res.status(500).json({ error: 'Dev login failed' });
  }

  res.json({ session: data.session });
};
