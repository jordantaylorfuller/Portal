const { adminClient } = require('../../lib/supabase');
const { resolveFrontendOrigin } = require('../../lib/origin');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  console.log('Sending magic link to:', email);

  const frontendOrigin = resolveFrontendOrigin(req);

  const { data, error } = await adminClient.auth.admin.generateLink({
    type: 'magiclink',
    email,
    options: { redirectTo: frontendOrigin }
  });

  if (error) {
    console.error('Magic link generation error:', error.message, error);
    return res.json({ ok: true });
  }

  const magicLinkUrl = data.properties.action_link;
  console.log('Magic link generated for:', email);

  if (process.env.RESEND_API_KEY) {
    try {
      await sendMagicLinkEmail(email, magicLinkUrl);
    } catch (err) {
      console.error('Resend send error:', err.message);
    }
  }

  res.json({ ok: true });
};

function buildMagicLinkEmail(url) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#111;font-family:'DM Mono',Menlo,Consolas,monospace;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#111;">
<tr><td align="center" style="padding:48px 24px;">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;">
<tr><td style="font-size:14px;color:#ffffff;line-height:1.6;padding-bottom:28px;">
Click below to sign in to your NIPC client portal.
</td></tr>
<tr><td style="padding-bottom:36px;">
<a href="${url}" style="display:inline-block;padding:12px 28px;background:#cc3333;color:#ffffff;text-decoration:none;font-family:'DM Mono',Menlo,Consolas,monospace;font-size:13px;font-weight:400;letter-spacing:0.05em;">SIGN IN</a>
</td></tr>
<tr><td style="font-size:10px;color:#666;padding-top:24px;border-top:1px solid #222;">
New International Picture Company
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

async function sendMagicLinkEmail(email, magicLinkUrl) {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/New_York'
  });
  const subject = `NIPC Portal — Sign In (${timeStr})`;

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'NIPC <hello@nipc.tv>',
      to: [email],
      subject,
      html: buildMagicLinkEmail(magicLinkUrl)
    })
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(JSON.stringify(data));
  return data;
}

module.exports.sendMagicLinkEmail = sendMagicLinkEmail;
