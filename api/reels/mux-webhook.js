const { adminClient } = require('../../lib/supabase');
const { verifyWebhook } = require('../../lib/mux');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const raw = await readRaw(req);
  const sig = req.headers['mux-signature'];
  if (!verifyWebhook(raw, sig)) {
    console.error('Mux webhook signature mismatch');
    return res.status(401).json({ error: 'Bad signature' });
  }

  let event;
  try { event = JSON.parse(raw); }
  catch { return res.status(400).json({ error: 'Bad JSON' }); }

  const type = event.type;
  const data = event.data || {};
  const assetId = data.id;

  if (!assetId) return res.status(200).json({ ok: true });

  if (type === 'video.asset.ready') {
    const playbackId = (data.playback_ids || []).find(p => p.policy === 'public')?.id || null;
    await adminClient.from('reel_assets').update({
      status: 'ready',
      mux_playback_id: playbackId,
      duration_seconds: data.duration || null,
    }).eq('mux_asset_id', assetId);
  } else if (type === 'video.asset.errored' || type === 'video.asset.deleted') {
    await adminClient.from('reel_assets').update({
      status: type === 'video.asset.deleted' ? 'archived' : 'error',
    }).eq('mux_asset_id', assetId);
  }

  res.status(200).json({ ok: true });
};

module.exports.config = { api: { bodyParser: false } };

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
