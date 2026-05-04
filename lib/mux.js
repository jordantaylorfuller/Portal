const crypto = require('crypto');
const MuxModule = require('@mux/mux-node');
const Mux = MuxModule.default || MuxModule;

let _client;
function client() {
  if (_client) return _client;
  if (!process.env.MUX_TOKEN_ID || !process.env.MUX_TOKEN_SECRET) {
    throw new Error('MUX_TOKEN_ID / MUX_TOKEN_SECRET not configured');
  }
  _client = new Mux({
    tokenId: process.env.MUX_TOKEN_ID,
    tokenSecret: process.env.MUX_TOKEN_SECRET,
  });
  return _client;
}

async function createAssetFromUrl(url) {
  return client().video.assets.create({
    inputs: [{ url }],
    playback_policy: ['public'],
  });
}

async function deleteAsset(assetId) {
  if (!assetId) return;
  try {
    await client().video.assets.delete(assetId);
  } catch (err) {
    if (err && err.status === 404) return;
    throw err;
  }
}

function verifyWebhook(rawBody, signatureHeader, secret = process.env.MUX_WEBHOOK_SIGNING_SECRET) {
  if (!signatureHeader || !secret) return false;
  const parts = Object.fromEntries(signatureHeader.split(',').map(p => p.split('=')));
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;
  const skew = Math.abs(Date.now() / 1000 - Number(t));
  if (!Number.isFinite(skew) || skew > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(v1, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { createAssetFromUrl, deleteAsset, verifyWebhook };
