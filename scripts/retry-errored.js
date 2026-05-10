#!/usr/bin/env node
/**
 * Re-ingests Mux assets that failed with download_failed. The Storj objects
 * still exist; we just need to ask Mux to fetch them again, throttled this
 * time so the concurrent pulls don't trip whatever caused the first round
 * to fail.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local'), override: true });
const { adminClient } = require('../lib/supabase');
const { presignGet } = require('../lib/storj');
const { createAssetFromUrl, deleteAsset } = require('../lib/mux');
const Mux = require('@mux/mux-node').default;
const m = new Mux({ tokenId: process.env.MUX_TOKEN_ID, tokenSecret: process.env.MUX_TOKEN_SECRET });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const { data: errored } = await adminClient
    .from('reel_assets').select('id, title, s3_key, mux_asset_id').eq('status','error');
  console.log('Retrying', errored?.length || 0, 'errored asset(s)…');

  for (const a of errored || []) {
    process.stdout.write(`  → ${a.title}\n`);
    if (a.mux_asset_id) {
      await deleteAsset(a.mux_asset_id).catch(e => console.log('    (delete old:', e.message + ')'));
    }
    try {
      const url = await presignGet(a.s3_key, 60 * 60 * 24);
      const asset = await createAssetFromUrl(url);
      await adminClient.from('reel_assets')
        .update({ mux_asset_id: asset.id, status: 'encoding', mux_playback_id: null })
        .eq('id', a.id);
      console.log(`    ✓ requested re-ingest, mux_id=${asset.id}`);
    } catch (e) {
      console.log(`    ✗ ${e.message}`);
    }
    await sleep(8000);
  }

  console.log('\nWaiting 60s for Mux to process, then polling…');
  await sleep(60000);

  for (let pass = 1; pass <= 6; pass++) {
    const { data: pending } = await adminClient
      .from('reel_assets').select('id, title, mux_asset_id').eq('status','encoding');
    if (!pending?.length) { console.log('All done.'); return; }
    console.log(`\nPoll #${pass}: ${pending.length} still encoding`);
    for (const a of pending) {
      try {
        const asset = await m.video.assets.retrieve(a.mux_asset_id);
        if (asset.status === 'ready') {
          await adminClient.from('reel_assets').update({
            status: 'ready',
            mux_playback_id: asset.playback_ids[0].id,
            duration_seconds: asset.duration,
          }).eq('id', a.id);
          console.log(`  ✓ ${a.title} ready (${asset.duration}s)`);
        } else if (asset.status === 'errored') {
          await adminClient.from('reel_assets').update({ status: 'error' }).eq('id', a.id);
          console.log(`  ✗ ${a.title} errored:`, JSON.stringify(asset.errors));
        }
      } catch (e) { console.log(`  ? ${a.title}: ${e.message}`); }
    }
    await sleep(30000);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
