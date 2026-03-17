const { createClient } = require('@supabase/supabase-js');
const config = require('../config');

// Admin client -- uses service role key, bypasses RLS
const adminClient = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

// Create a client scoped to a specific user's JWT (respects RLS)
function createClientForUser(jwt) {
  return createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: 'Bearer ' + jwt } },
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

module.exports = { adminClient, createClientForUser };
