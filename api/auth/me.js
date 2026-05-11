const { getAuthUser } = require('../../lib/auth');
const { adminClient, createClientForUser } = require('../../lib/supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await getAuthUser(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const { data: profile } = await adminClient
    .from('user_profiles')
    .select('display_name, initials, role')
    .eq('id', auth.id)
    .single();

  // Use a user-scoped client for the projects join so RLS filters out
  // Internal projects for non-admins. The "Admins read all projects" and
  // "Members read visible projects" policies (Phase 1 migration) are the
  // single source of truth for visibility — service-role queries bypass them.
  const userClient = createClientForUser(auth.token);
  const { data: memberships } = await userClient
    .from('project_members')
    .select('project_id, role, review_seen_at, delivery_seen_at, projects(id, name, display_name, status)')
    .eq('user_id', auth.id);

  const visibleMemberships = (memberships || [])
    .filter(m => m.projects && m.projects.status !== 'archived');

  const projectIds = visibleMemberships.map(m => m.projects.id);

  // Per-project unseen counts for the Review and Delivery room badges.
  // Computed with service-role so we can count rows in a single round trip;
  // RLS visibility was already enforced on the membership join above.
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

  const projects = visibleMemberships.map(m => ({
    id: m.projects.id,
    name: m.projects.display_name || m.projects.name,
    status: m.projects.status,
    role: m.role,
    unseen: unseenByProject[m.projects.id] || { review: 0, delivery: 0 }
  }));

  const needsProfile = !profile;

  res.json({
    email: auth.email,
    displayName: profile ? profile.display_name : auth.email.split('@')[0],
    initials: profile ? profile.initials : auth.email.slice(0, 2).toUpperCase(),
    role: profile ? profile.role : 'client',
    needsProfile,
    projects
  });
};
