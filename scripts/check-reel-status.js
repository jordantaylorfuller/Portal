#!/usr/bin/env node
/** Inspect status of the three editor reels & their assets. */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local'), override: true });
const { adminClient } = require('../lib/supabase');

const SLUGS = ['carla-luffe', 'josh-lee', 'lucian-johnston'];

async function main() {
  const { data: reels } = await adminClient.from('reels').select('*').in('slug', SLUGS);
  for (const reel of reels || []) {
    const { data: assets } = await adminClient
      .from('reel_assets').select('id, title, status, duration_seconds, mux_playback_id')
      .eq('reel_id', reel.id).order('sort_order');
    const counts = (assets || []).reduce((a, x) => { a[x.status] = (a[x.status] || 0) + 1; return a; }, {});
    console.log(`\n[${reel.slug}] ${reel.title} • status=${reel.status} • ${assets?.length || 0} assets`);
    console.log(`  ${JSON.stringify(counts)}`);
    for (const a of assets || []) {
      const playable = a.mux_playback_id ? '✓' : '·';
      console.log(`  ${playable} [${a.status.padEnd(9)}] ${(a.duration_seconds ?? '—').toString().padStart(7)}s  ${a.title}`);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
