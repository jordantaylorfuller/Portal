#!/usr/bin/env node
/**
 * Pulls the three editor reels from Supabase and rewrites home/data/editors.json
 * and home/data/works.json so the home page roster reflects the current set of
 * editors and their videos. Each Mux asset becomes one "work" entry. After this
 * runs, scripts/build-cms-pages.mjs regenerates the static editor/work pages.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local'), override: true });
const fs = require('fs');
const path = require('path');
const { adminClient } = require('../lib/supabase');

const DATA_DIR = path.join(__dirname, '..', 'home', 'data');

const EDITORS = [
  {
    slug: 'carla-luffe',
    name: 'Carla Luffe',
    bio: 'Carla cuts brand and fashion films across the world’s biggest names — spanning beauty, luxury, automotive, and culture.',
    featureClients: 'Apple, Burberry, Hermès, Vogue, Meta, Volvo',
    typeOfWork: 'Commercial',
  },
  {
    slug: 'josh-lee',
    name: 'Josh Lee',
    bio: 'Josh edits long-form narrative — prestige film and television trailers driven by character, restraint, and tension.',
    featureClients: 'Netflix, A24',
    typeOfWork: 'Trailer',
  },
  {
    slug: 'lucian-johnston',
    name: 'Lucian Johnston',
    bio: 'Lucian shapes trailers for some of A24’s most singular films — where dread, tone, and rhythm do the heavy lifting.',
    featureClients: 'A24',
    typeOfWork: 'Trailer',
  },
];

function muxThumb(playbackId, params = {}) {
  const qs = new URLSearchParams({ width: '1280', fit_mode: 'preserve', ...params });
  return `https://image.mux.com/${playbackId}/thumbnail.jpg?${qs}`;
}

// Resolve a *stable* poster URL for the static CMS output. Custom uploaded
// posters (asset.poster_url, an opaque Storj key) are NOT signed here — Storj
// presigned URLs expire (max 7d), so baking them into works.json silently
// breaks every consumer after the TTL. Consumers that need the admin-selected
// poster fetch a fresh signed URL from /api/reels/public at runtime
// (home page via cms-inject.js, reel.html via the category-path sync).
function resolvePoster(asset) {
  if (asset.poster_time != null) {
    return `https://image.mux.com/${asset.mux_playback_id}/thumbnail.jpg?width=1280&time=${asset.poster_time}`;
  }
  return muxThumb(asset.mux_playback_id);
}

function muxAnimated(playbackId) {
  return `https://image.mux.com/${playbackId}/animated.gif?width=640&height=360&fps=15`;
}

// "APPLE x Mackenzie Sheppard"  -> { client: "APPLE", name: "APPLE", director: "Mackenzie Sheppard" }
// "Ripley Netflix"              -> { client: "Netflix", name: "Ripley", director: null }
// "Beau Is Afraid A24"          -> { client: "A24", name: "Beau Is Afraid", director: null }
function parseTitle(title, editorTypeOfWork) {
  const xMatch = title.split(/\s+x\s+/i);
  if (xMatch.length === 2) {
    return { client: xMatch[0].trim(), name: xMatch[0].trim(), director: xMatch[1].trim(), typeOfWork: editorTypeOfWork };
  }
  if (xMatch.length > 2) {
    return { client: xMatch[0].trim(), name: xMatch[0].trim(), director: xMatch.slice(1).join(' x ').trim(), typeOfWork: editorTypeOfWork };
  }
  // Trailing brand pattern: "Name Studio"
  const tail = title.match(/^(.+?)\s+(Netflix|A24|HBO|Apple|HBO Max|Hulu|Amazon|Prime)$/i);
  if (tail) return { client: tail[2], name: tail[1].trim(), director: null, typeOfWork: editorTypeOfWork };
  return { client: '', name: title, director: null, typeOfWork: editorTypeOfWork };
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

async function main() {
  const slugs = EDITORS.map(e => e.slug);
  const { data: reels, error: re } = await adminClient
    .from('reels').select('id, slug, title, description').in('slug', slugs);
  if (re) throw re;

  const { data: assets, error: ae } = await adminClient
    .from('reel_assets')
    .select('id, reel_id, title, mux_playback_id, duration_seconds, sort_order, poster_url, poster_time')
    .in('reel_id', reels.map(r => r.id))
    .eq('status', 'ready')
    .order('sort_order');
  if (ae) throw ae;

  const reelById = new Map(reels.map(r => [r.id, r]));

  // Build works (one per Mux asset).
  const works = [];
  const editorWorkIds = new Map(EDITORS.map(e => [e.slug, []]));
  const slugCounts = new Map();

  for (const asset of assets) {
    const reel = reelById.get(asset.reel_id);
    const editor = EDITORS.find(e => e.slug === reel.slug);
    if (!editor) continue;
    const parsed = parseTitle(asset.title, editor.typeOfWork);

    let baseSlug = slugify(`${editor.slug}-${parsed.name || asset.title}`);
    const seen = slugCounts.get(baseSlug) || 0;
    slugCounts.set(baseSlug, seen + 1);
    const finalSlug = seen === 0 ? baseSlug : `${baseSlug}-${seen + 1}`;

    const poster = resolvePoster(asset);

    works.push({
      id: asset.id,
      name: parsed.name,
      slug: finalSlug,
      client: parsed.client || editor.name,
      year: '2026',
      typeOfWork: parsed.typeOfWork,
      director: parsed.director,
      visitLink: `/reel.html?s=${editor.slug}#${asset.id}`,
      thumbnailCover: poster,
      video: {
        url: `/reel.html?s=${editor.slug}#${asset.id}`,
        title: asset.title,
        provider: 'Mux',
        thumbnail: poster,
        playbackId: asset.mux_playback_id,
        durationSeconds: asset.duration_seconds,
      },
      referenceEditors: null,
      order: asset.sort_order,
      isDraft: false,
    });
    editorWorkIds.get(editor.slug).push(asset.id);
  }

  // Build editors (one card per editor, with their work IDs).
  const editorItems = EDITORS.map((e, i) => {
    const reel = reels.find(r => r.slug === e.slug);
    const firstAsset = assets.find(a => a.reel_id === reel?.id);
    return {
      id: reel?.id || e.slug,
      name: e.name,
      slug: e.slug,
      role: 'Senior Editor',
      featureClients: e.featureClients,
      yearRange: '2026',
      bio: e.bio,
      order: i + 1,
      numOnList: String(i + 1).padStart(2, '0'),
      referencingWork: editorWorkIds.get(e.slug),
      workPreviewLoopingGif: firstAsset ? muxAnimated(firstAsset.mux_playback_id) : '',
      reelSlug: e.slug,
      isDraft: false,
    };
  });

  const editorsJson = {
    _meta: {
      source: 'Generated from Supabase reels',
      snapshotAt: new Date().toISOString().slice(0, 10),
      totalItems: editorItems.length,
    },
    items: editorItems,
  };
  const worksJson = {
    _meta: {
      source: 'Generated from Supabase reel_assets',
      snapshotAt: new Date().toISOString().slice(0, 10),
      totalItems: works.length,
    },
    items: works,
  };

  fs.writeFileSync(path.join(DATA_DIR, 'editors.json'), JSON.stringify(editorsJson, null, 2));
  fs.writeFileSync(path.join(DATA_DIR, 'works.json'), JSON.stringify(worksJson, null, 2));
  console.log(`Wrote ${editorItems.length} editors and ${works.length} works.`);
}

main().catch(e => { console.error(e); process.exit(1); });
