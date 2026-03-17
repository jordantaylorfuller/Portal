const { adminClient } = require('./supabase');

async function getAuthUser(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return null;
  }
  const token = auth.replace('Bearer ', '');
  const { data: { user }, error } = await adminClient.auth.getUser(token);
  if (error || !user) return null;
  return {
    id: user.id,
    email: user.email,
    metadata: user.user_metadata,
    token
  };
}

module.exports = { getAuthUser };
