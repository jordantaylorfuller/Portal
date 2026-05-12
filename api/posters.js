// Public canonical-poster lookup keyed by mux_playback_id. Used by surfaces
// that aren't scoped to a single reel (the home page goes through
// /api/reels/public per editor, but category reels in reel.html and the
// static editors/works pages have a list of playback ids and need the
// admin-curated poster for each one).
//
// GET /api/posters?ids=<comma-separated-playback-ids>
// → { posters: { [playbackId]: { poster, poster_focal_x, poster_focal_y, poster_zoom } } }

const { adminClient } = require('../lib/supabase');
const { presignGet } = require('../lib/storj');

const MAX_IDS = 100;

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const raw = String(req.query.ids || '').trim();
  if (!raw) return res.json({ posters: {} });

  const ids = [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean))].slice(0, MAX_IDS);
  if (!ids.length) return res.json({ posters: {} });

  try {
    const { data, error } = await adminClient
      .from('video_posters')
      .select('mux_playback_id, poster_url, poster_time, poster_focal_x, poster_focal_y, poster_zoom')
      .in('mux_playback_id', ids);
    if (error) throw error;

    const out = {};
    for (const row of data || []) {
      out[row.mux_playback_id] = {
        poster:         await resolvePosterUrl(row),
        poster_focal_x: Number(row.poster_focal_x ?? 50),
        poster_focal_y: Number(row.poster_focal_y ?? 50),
        poster_zoom:    Number(row.poster_zoom    ?? 1),
      };
    }
    // 60s edge cache: admin poster changes propagate within the minute even on
    // statically-served editor/work pages, without hammering the function on
    // every page view.
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    res.json({ posters: out });
  } catch (err) {
    console.error('/api/posters error:', err.message);
    res.status(500).json({ error: err.message });
  }
};

async function resolvePosterUrl(row) {
  if (row.poster_url) {
    try { return await presignGet(row.poster_url, 60 * 60 * 24); }
    catch (e) { console.error('poster presign failed', e.message); }
  }
  if (row.poster_time != null) {
    return `https://image.mux.com/${row.mux_playback_id}/thumbnail.jpg?width=1280&time=${row.poster_time}`;
  }
  return `https://image.mux.com/${row.mux_playback_id}/thumbnail.jpg?width=1280`;
}
