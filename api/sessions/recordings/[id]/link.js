const { getAuthUser } = require('../../../../lib/auth');
const { getRecordingLink } = require('../../../../lib/daily');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await getAuthUser(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const { id } = req.query;

  try {
    const url = await getRecordingLink(id);
    res.json({ url });
  } catch (err) {
    console.error('Recording link error:', err.message);
    res.status(500).json({ error: 'Failed to get recording link' });
  }
};
