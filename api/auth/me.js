const { getAuthUser } = require('../../lib/auth');
const { adminClient, createClientForUser } = require('../../lib/supabase');
const { isAdmin: isAdminUser, isStaffEmail } = require('../../lib/admin');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await getAuthUser(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  let { data: profile } = await adminClient
    .from('user_profiles')
    .select('display_name, initials, role')
    .eq('id', auth.id)
    .maybeSingle();

  // Self-heal: any signed-in @nipc.tv user is staff. Promote the row so
  // Supabase RLS policies that check user_profiles.role see them as admin too.
  if (profile && isStaffEmail(auth.email) && profile.role !== 'admin') {
    await adminClient
      .from('user_profiles')
      .update({ role: 'admin' })
      .eq('id', auth.id);
    profile = { ...profile, role: 'admin' };
  }

  const isAdmin = isAdminUser(profile, auth.email);
  const projects = isAdmin
    ? await loadProjectsForAdmin()
    : await loadProjectsForMember(auth);

  const needsProfile = !profile;

  res.json({
    email: auth.email,
    displayName: profile ? profile.display_name : auth.email.split('@')[0],
    initials: profile ? profile.initials : auth.email.slice(0, 2).toUpperCase(),
    role: isAdmin ? 'admin' : (profile ? profile.role : 'client'),
    needsProfile,
    projects
  });
};

// Admins see every active project regardless of project_members rows.
// Archived projects are hidden here; they're managed in /admin-frameio.html.
// Unseen counts are zeroed because admins aren't the audience for room badges.
async function loadProjectsForAdmin() {
  const { data, error } = await adminClient
    .from('projects')
    .select('id, name, display_name, status')
    .eq('status', 'active')
    .order('display_name', { ascending: true, nullsFirst: false });
  if (error) {
    console.error('admin projects fetch failed:', error.message);
    return [];
  }
  return (data || []).map(p => ({
    id: p.id,
    name: p.display_name || p.name,
    status: 'active',
    role: 'admin',
    unseen: { review: 0, delivery: 0 }
  }));
}

// Clients see only active projects they're members of, filtered by RLS.
async function loadProjectsForMember(auth) {
  const userClient = createClientForUser(auth.token);
  const { data: memberships } = await userClient
    .from('project_members')
    .select('project_id, role, review_seen_at, delivery_seen_at, projects(id, name, display_name, status)')
    .eq('user_id', auth.id);

  const visibleMemberships = (memberships || [])
    .filter(m => m.projects && m.projects.status === 'active');

  const projectIds = visibleMemberships.map(m => m.projects.id);
  const unseenByProject = {};
  for (const id of projectIds) unseenByProject[id] = { review: 0, delivery: 0 };

  if (projectIds.length > 0) {
    const seenByProject = {};
    visibleMemberships.forEach(m => {
      seenByProject[m.projects.id] = {
        review: m.review_seen_at,
        delivery: m.delivery_seen_at
      };
    });

    await Promise.all(projectIds.flatMap(id => {
      const seen = seenByProject[id] || { review: null, delivery: null };
      return [
        (async () => {
          let q = adminClient
            .from('review_assets')
            .select('id', { count: 'exact', head: true })
            .eq('project_id', id)
            .neq('status', 'archived');
          if (seen.review) q = q.gt('created_at', seen.review);
          const { count } = await q;
          unseenByProject[id].review = count || 0;
        })(),
        (async () => {
          let q = adminClient
            .from('delivery_assets')
            .select('id', { count: 'exact', head: true })
            .eq('project_id', id);
          if (seen.delivery) q = q.gt('created_at', seen.delivery);
          const { count } = await q;
          unseenByProject[id].delivery = count || 0;
        })()
      ];
    }));
  }

  return visibleMemberships.map(m => ({
    id: m.projects.id,
    name: m.projects.display_name || m.projects.name,
    status: m.projects.status,
    role: m.role,
    unseen: unseenByProject[m.projects.id] || { review: 0, delivery: 0 }
  }));
}
