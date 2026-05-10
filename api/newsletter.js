module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email } = req.body || {};
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'Email is required' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  const formUrl = process.env.BREVO_FORM_URL;
  if (!formUrl) {
    console.error('BREVO_FORM_URL is not set');
    return res.status(500).json({ error: 'Newsletter is not configured' });
  }

  try {
    const params = new URLSearchParams();
    params.set('EMAIL', email);
    // Brevo honeypot field — must be empty.
    params.set('email_address_check', '');
    params.set('locale', 'en');

    const resp = await fetch(formUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      redirect: 'manual'
    });

    // Brevo redirects (302/303) to its thank-you page on success, or returns 200 with the form HTML.
    if (resp.status >= 200 && resp.status < 400) {
      return res.json({ ok: true });
    }
    console.error('Brevo form error', resp.status);
    return res.status(502).json({ error: 'Could not subscribe' });
  } catch (err) {
    console.error('Brevo request failed:', err.message);
    return res.status(502).json({ error: 'Could not subscribe' });
  }
};
