#!/usr/bin/env node
/**
 * One-shot importer: creates reels for the three NIPC editors and uploads
 * every video in /Volumes/Lucid/NIPC/<EDITOR> to Storj, registering each
 * one as a Mux asset. Mux finishes encoding asynchronously; rerunning is
 * safe because we skip files whose s3_key already exists for the reel.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local'), override: true });

const fs = require('fs');
const path = require('path');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { adminClient } = require('../lib/supabase');
const { createAssetFromUrl } = require('../lib/mux');

const SOURCE_ROOT = '/Volumes/Lucid/NIPC';
const ROOT_PREFIX = (process.env.REELS_ROOT_PREFIX || 'reels/').replace(/\/+$/, '') + '/';
const VIDEO_EXTS = new Set(['.mov', '.mp4', '.m4v', '.mkv', '.webm', '.avi', '.mxf']);

const EDITORS = [
  { slug: 'josh-lee',        folder: 'JOSH LEE',        title: 'Josh Lee',        description: 'Selected work.' },
  { slug: 'lucian-johnston', folder: 'LUCIAN JOHNSTON', title: 'Lucian Johnston', description: 'Selected work.' },
  { slug: 'carla-luffe',     folder: 'CARLA LUFFE',     title: 'Carla Luffe',     description: 'Selected work.' },
];

const s3 = new S3Client({
  endpoint: process.env.STORJ_ENDPOINT || 'https://gateway.storjshare.io',
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.STORJ_ACCESS_KEY,
    secretAccessKey: process.env.STORJ_SECRET_KEY,
  },
  forcePathStyle: true,
});
const BUCKET = process.env.STORJ_BUCKET;

function titleize(filenameNoExt) {
  return filenameNoExt
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\bOfficial Trailer\b/gi, '')
    .replace(/\bHD\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeName(name) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

async function ensureReel(editor) {
  const s3_prefix = `${ROOT_PREFIX}${editor.slug}/`;
  const { data: existing } = await adminClient
    .from('reels').select('*').eq('slug', editor.slug).maybeSingle();
  if (existing) {
    console.log(`[${editor.slug}] reel already exists (id=${existing.id})`);
    return existing;
  }
  const { data, error } = await adminClient
    .from('reels')
    .insert({
      slug: editor.slug,
      title: editor.title,
      description: editor.description,
      s3_prefix,
      status: 'draft',
    })
    .select().single();
  if (error) throw error;
  console.log(`[${editor.slug}] created reel id=${data.id}`);
  return data;
}

async function uploadOne(reel, sourcePath) {
  const filename = path.basename(sourcePath);
  const ext = path.extname(filename).toLowerCase();
  if (!VIDEO_EXTS.has(ext)) return { skipped: true, reason: 'non-video', filename };

  const stem = path.basename(filename, ext);
  const title = titleize(stem);
  const s3_key = `${reel.s3_prefix}${Date.now()}-${safeName(filename)}`;

  // Skip if a row with the same title already exists for this reel (rerun safety).
  const { data: dup } = await adminClient
    .from('reel_assets').select('id, s3_key, status')
    .eq('reel_id', reel.id).eq('title', title).maybeSingle();
  if (dup) return { skipped: true, reason: `already registered (${dup.status})`, filename, asset_id: dup.id };

  const stat = fs.statSync(sourcePath);
  console.log(`  → uploading ${filename} (${(stat.size / (1024*1024)).toFixed(1)} MB) to ${s3_key}`);

  const upload = new Upload({
    client: s3,
    params: {
      Bucket: BUCKET,
      Key: s3_key,
      Body: fs.createReadStream(sourcePath),
      ContentType: ext === '.mov' ? 'video/quicktime' : 'video/mp4',
    },
    queueSize: 4,
    partSize: 16 * 1024 * 1024,
  });
  let lastPct = -1;
  upload.on('httpUploadProgress', (p) => {
    if (!p.total) return;
    const pct = Math.floor((p.loaded / p.total) * 100);
    if (pct !== lastPct && pct % 20 === 0) {
      process.stdout.write(`    … ${pct}%\n`);
      lastPct = pct;
    }
  });
  await upload.done();

  const { data: maxRow } = await adminClient
    .from('reel_assets').select('sort_order').eq('reel_id', reel.id)
    .order('sort_order', { ascending: false }).limit(1).maybeSingle();
  const sort_order = (maxRow?.sort_order ?? -1) + 1;

  const { data: row, error: insErr } = await adminClient
    .from('reel_assets')
    .insert({ reel_id: reel.id, s3_key, title, sort_order, status: 'uploading' })
    .select().single();
  if (insErr) throw insErr;

  try {
    const presigned = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: BUCKET, Key: s3_key }),
      { expiresIn: 60 * 60 * 24 }
    );
    const asset = await createAssetFromUrl(presigned);
    await adminClient.from('reel_assets')
      .update({ mux_asset_id: asset.id, status: 'encoding' })
      .eq('id', row.id);
    console.log(`    ✓ Mux asset ${asset.id} created (encoding…)`);
    return { uploaded: true, filename, asset_id: row.id, mux_asset_id: asset.id };
  } catch (err) {
    console.error(`    ✗ Mux create failed: ${err.message}`);
    await adminClient.from('reel_assets').update({ status: 'error' }).eq('id', row.id);
    return { uploaded: true, filename, asset_id: row.id, error: err.message };
  }
}

async function main() {
  for (const editor of EDITORS) {
    const folder = path.join(SOURCE_ROOT, editor.folder);
    if (!fs.existsSync(folder)) {
      console.warn(`[${editor.slug}] folder missing: ${folder} — skipping`);
      continue;
    }
    let files = fs.readdirSync(folder)
      .filter(f => VIDEO_EXTS.has(path.extname(f).toLowerCase()))
      .sort()
      .map(f => path.join(folder, f));
    if (editor.limit) files = files.slice(0, editor.limit);
    if (!files.length) {
      console.warn(`[${editor.slug}] no videos in ${folder}`);
      continue;
    }
    const reel = await ensureReel(editor);
    console.log(`[${editor.slug}] ${files.length} videos to import`);
    for (const file of files) {
      try {
        const result = await uploadOne(reel, file);
        if (result.skipped) console.log(`  · skip ${result.filename}: ${result.reason}`);
      } catch (err) {
        console.error(`  ✗ ${path.basename(file)}: ${err.message}`);
      }
    }
  }
  console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
