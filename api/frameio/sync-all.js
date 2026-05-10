// Cron entrypoint. Iterates every portal project linked to a Frame.io
// project and runs syncOne on each. Returns an aggregate report.
// Configured in vercel.json with schedule "*/5 * * * *".
//
// Authentication: Vercel cron requests carry an Authorization header with
// the project's CRON_SECRET (if set). For now we leave this open and rely
// on the obscurity of the path; tighten before going to production.

const { adminClient } = require('../../lib/supabase');
const { syncOne } = require('./sync');
const { discoverAndUpsertProjects } = require('./sync-projects');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (process.env.CRON_SECRET) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  // Step 1: discover/refresh projects from Frame.io.
  let discovery = null;
  try {
    discovery = await discoverAndUpsertProjects();
  } catch (err) {
    console.error('sync-all discovery failed:', err.message);
    discovery = { error: err.message };
  }

  // Step 2: per-project file sync for every active linked project.
  const { data: projects, error } = await adminClient
    .from('projects')
    .select('id, name')
    .not('frameio_project_id', 'is', null)
    .neq('status', 'archived');
  if (error) return res.status(500).json({ error: error.message });

  const report = [];
  for (const p of projects || []) {
    try {
      const r = await syncOne(p.id);
      report.push({ project: p.name, ...r });
    } catch (err) {
      report.push({ project: p.name, error: err.message });
    }
  }

  return res.json({
    ok: true,
    discovery,
    count: (projects || []).length,
    report
  });
};
