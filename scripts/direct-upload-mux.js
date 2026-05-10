#!/usr/bin/env node
/**
 * For Carla rows in 'error' state, push the local source file directly to
 * Mux's signed upload URL — bypassing Storj entirely. We hit this path when
 * Storj's project bandwidth ran out and Mux couldn't pull videos for ingest.
 *
 * Storj still has the originals (so the source-of-truth bucket stays intact),
 * but the Mux asset is created from a fresh PUT instead of a Storj URL.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local'), override: true });
const fs = require('fs');
const path = require('path');
const { adminClient } = require('../lib/supabase');
const { deleteAsset } = require('../lib/mux');
const Mux = require('@mux/mux-node').default;
const m = new Mux({ tokenId: process.env.MUX_TOKEN_ID, tokenSecret: process.env.MUX_TOKEN_SECRET });

const SOURCE = '/Volumes/Lucid/NIPC/CARLA LUFFE';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function findLocalFile(s3_key) {
  // s3_key looks like 'reels/carla-luffe/1778007194222-UBER_x_Mother_x_Michael_Spiccia.mov'
  // The local filename had spaces & special chars which got sanitized; reverse-search by stem.
  const sanitized = s3_key.split('/').pop().replace(/^\d+-/, '');
  // Match every file in source folder; pick the one whose sanitized name matches.
  const files = fs.readdirSync(SOURCE);
  for (const f of files) {
    const safe = f.replace(/[^a-zA-Z0-9._-]+/g, '_');
    if (safe === sanitized) return path.join(SOURCE, f);
  }
  return null;
}

async function uploadOne(row) {
  const local = findLocalFile(row.s3_key);
  if (!local) { console.log(`  ✗ ${row.title}: local file not found for ${row.s3_key}`); return; }
  const stat = fs.statSync(local);
  console.log(`  → ${row.title} (${(stat.size / (1024*1024)).toFixed(0)} MB) from ${path.basename(local)}`);

  // Tear down the old failed asset.
  if (row.mux_asset_id) {
    await deleteAsset(row.mux_asset_id).catch(() => {});
  }

  // Mark uploading so we don't re-process if rerun.
  await adminClient.from('reel_assets').update({ status: 'uploading', mux_asset_id: null }).eq('id', row.id);

  // Get a Mux direct-upload URL.
  const upload = await m.video.uploads.create({
    cors_origin: '*',
    new_asset_settings: { playback_policy: ['public'] },
  });

  // PUT the file to Mux's URL.
  const ext = path.extname(local).toLowerCase();
  const ct = ext === '.mov' ? 'video/quicktime' : 'video/mp4';
  const res = await fetch(upload.url, {
    method: 'PUT',
    body: fs.createReadStream(local),
    headers: { 'Content-Length': String(stat.size), 'Content-Type': ct },
    duplex: 'half',
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Mux PUT ${res.status}: ${body.slice(0, 200)}`);
  }
  console.log(`    ✓ pushed to Mux (upload_id=${upload.id})`);

  // Poll the upload until Mux assigns an asset_id, then mark encoding.
  for (let i = 0; i < 30; i++) {
    await sleep(4000);
    const u = await m.video.uploads.retrieve(upload.id);
    if (u.asset_id) {
      await adminClient.from('reel_assets')
        .update({ mux_asset_id: u.asset_id, status: 'encoding' })
        .eq('id', row.id);
      console.log(`    → asset_id=${u.asset_id}, encoding`);
      return u.asset_id;
    }
    if (u.status === 'errored') {
      await adminClient.from('reel_assets').update({ status: 'error' }).eq('id', row.id);
      throw new Error(`Mux upload errored: ${JSON.stringify(u.error)}`);
    }
  }
  console.log('    ? still no asset_id after 2 minutes — Mux is processing, will catch up on next poll');
}

async function pollUntilDone() {
  console.log('\nPolling encoding rows…');
  for (let pass = 1; pass <= 12; pass++) {
    const { data: pending } = await adminClient
      .from('reel_assets').select('id, title, mux_asset_id').in('status', ['encoding', 'uploading']);
    if (!pending?.length) { console.log('All ready.'); return; }
    console.log(`Pass #${pass}: ${pending.length} pending`);
    for (const a of pending) {
      if (!a.mux_asset_id) continue;
      try {
        const asset = await m.video.assets.retrieve(a.mux_asset_id);
        if (asset.status === 'ready') {
          await adminClient.from('reel_assets').update({
            status: 'ready',
            mux_playback_id: asset.playback_ids[0].id,
            duration_seconds: asset.duration,
          }).eq('id', a.id);
          console.log(`  ✓ ${a.title} (${asset.duration}s)`);
        } else if (asset.status === 'errored') {
          await adminClient.from('reel_assets').update({ status: 'error' }).eq('id', a.id);
          console.log(`  ✗ ${a.title} — ${JSON.stringify(asset.errors)}`);
        }
      } catch (e) { console.log(`  ? ${a.title}: ${e.message}`); }
    }
    await sleep(20000);
  }
}

async function main() {
  const { data: errored } = await adminClient
    .from('reel_assets').select('id, title, s3_key, mux_asset_id').eq('status','error');
  console.log(`Direct-uploading ${errored?.length || 0} rows to Mux`);
  for (const row of errored || []) {
    try { await uploadOne(row); }
    catch (e) { console.log(`    ✗ ${row.title}: ${e.message}`); }
  }
  await pollUntilDone();
}

main().catch(e => { console.error(e); process.exit(1); });
