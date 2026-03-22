const { createClient } = require('@supabase/supabase-js');

const adminClient = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

function createClientForUser(jwt) {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    {
      global: { headers: { Authorization: 'Bearer ' + jwt } },
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    }
  );
}

module.exports = { adminClient, createClientForUser };
