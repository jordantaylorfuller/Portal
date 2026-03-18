const { Router } = require('express');
const config = require('../config');
const { adminClient, createClientForUser } = require('../services/supabase');
const { requireAuth } = require('../middleware/auth');

const router = Router();

// POST /api/auth/magic-link
// Generate magic link via Supabase admin, send email via Resend
// Using Resend directly gives us dynamic subjects (prevents Gmail threading)
router.post('/magic-link', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  console.log('Sending magic link to:', email);

  // Generate the magic link URL (does not send email)
  const { data, error } = await adminClient.auth.admin.generateLink({
    type: 'magiclink',
    email,
    options: { redirectTo: config.FRONTEND_ORIGIN }
  });

  if (error) {
    console.error('Magic link generation error:', error.message, error);
    // Return ok to avoid leaking whether email exists
    return res.json({ ok: true });
  }

  const magicLinkUrl = data.properties.action_link;
  console.log('Magic link generated for:', email);

  // Send via Resend with a dynamic subject to prevent Gmail threading
  try {
    const result = await sendMagicLinkEmail(email, magicLinkUrl);
    console.log('Magic link email sent via Resend:', result.id);
  } catch (err) {
    console.error('Resend send error:', err.message);
  }

  // Always return ok to avoid leaking whether email exists
  res.json({ ok: true });
});

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

// POST /api/auth/verify
// Exchange OTP token from magic link for a session
router.post('/verify', async (req, res) => {
  const { token_hash, type } = req.body;
  if (!token_hash || !type) {
    return res.status(400).json({ error: 'token_hash and type are required' });
  }

  const { data, error } = await adminClient.auth.verifyOtp({
    token_hash,
    type
  });

  if (error) {
    console.error('Verify OTP error:', error.message);
    return res.status(400).json({ error: 'Invalid or expired link' });
  }

  res.json({
    session: {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at,
      user: {
        id: data.user.id,
        email: data.user.email
      }
    }
  });
});

// GET /api/auth/me
// Return authenticated user's profile and projects
router.get('/me', requireAuth, async (req, res) => {
  const userClient = createClientForUser(req.token);

  // Get user profile
  const { data: profile } = await adminClient
    .from('user_profiles')
    .select('display_name, initials, role')
    .eq('id', req.user.id)
    .single();

  // Get user's projects via membership
  const { data: memberships } = await adminClient
    .from('project_members')
    .select('project_id, role, projects(id, name, status)')
    .eq('user_id', req.user.id);

  const projects = (memberships || [])
    .filter(m => m.projects)
    .map(m => ({
      id: m.projects.id,
      name: m.projects.name,
      status: m.projects.status,
      role: m.role
    }));

  const needsProfile = !profile;

  res.json({
    email: req.user.email,
    displayName: profile ? profile.display_name : req.user.email.split('@')[0],
    initials: profile ? profile.initials : req.user.email.slice(0, 2).toUpperCase(),
    role: profile ? profile.role : 'client',
    needsProfile,
    projects
  });
});

// POST /api/auth/profile
// First-login: save display name and sync to Asana
router.post('/profile', requireAuth, async (req, res) => {
  const { firstName, lastName } = req.body;
  if (!firstName) return res.status(400).json({ error: 'First name is required' });

  const displayName = firstName.trim();
  const fullName = lastName ? `${firstName.trim()} ${lastName.trim()}` : displayName;
  const initials = lastName
    ? (firstName[0] + lastName[0]).toUpperCase()
    : firstName.slice(0, 2).toUpperCase();

  // Upsert user profile
  const { error: profileError } = await adminClient.from('user_profiles').upsert({
    id: req.user.id,
    display_name: displayName,
    initials,
    role: 'client'
  });

  if (profileError) {
    console.error('Profile upsert error:', profileError.message);
    return res.status(500).json({ error: 'Failed to save profile' });
  }

  // Sync to Asana: find or create contact in workspace
  if (config.ASANA_PAT) {
    try {
      await syncAsanaContact(req.user.email, fullName);
    } catch (err) {
      console.error('Asana sync error:', err.message);
      // Don't fail the request if Asana sync fails
    }
  }

  res.json({ displayName, initials });
});

// Search Asana tasks for a client email and update the name,
// or create a new task in the workspace
async function syncAsanaContact(email, fullName) {
  const workspaceGid = '1213458026214848';

  // Search for existing tasks with this email in custom fields
  const searchResp = await fetch(
    `https://app.asana.com/api/1.0/workspaces/${workspaceGid}/tasks/search?text=${encodeURIComponent(email)}&opt_fields=name,custom_fields.name,custom_fields.text_value,custom_fields.gid`,
    { headers: { Authorization: 'Bearer ' + config.ASANA_PAT } }
  );
  const searchData = await searchResp.json();
  const tasks = (searchData.data || []);

  // Find a task whose "Client Email" custom field matches
  for (const task of tasks) {
    const emailField = (task.custom_fields || []).find(
      f => f.name && f.name.toLowerCase().includes('client email') && f.text_value === email
    );
    if (emailField) {
      // Found the task -- update Client Name field
      const nameField = (task.custom_fields || []).find(
        f => f.name && f.name.toLowerCase().includes('client name')
      );
      if (nameField) {
        await fetch(`https://app.asana.com/api/1.0/tasks/${task.gid}`, {
          method: 'PUT',
          headers: {
            Authorization: 'Bearer ' + config.ASANA_PAT,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            data: { custom_fields: { [nameField.gid]: fullName } }
          })
        });
        console.log(`Updated Asana task ${task.gid} with name: ${fullName}`);
      }
      return;
    }
  }

  console.log(`No existing Asana task found for ${email}, skipping creation`);
}

// Shared helper for sending magic link emails via Resend
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
      Authorization: `Bearer ${config.RESEND_API_KEY}`,
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

// POST /api/auth/dev-login
// Dev-only: instant sign-in as a specific user (no email required)
router.post('/dev-login', async (req, res) => {
  const email = 'jordantaylorfuller@gmail.com';

  const { data, error } = await adminClient.auth.admin.generateLink({
    type: 'magiclink',
    email,
    options: { redirectTo: config.FRONTEND_ORIGIN }
  });

  if (error) {
    console.error('Dev login error:', error.message);
    return res.status(500).json({ error: 'Failed to generate dev session' });
  }

  const url = new URL(data.properties.action_link);
  const tokenHash = url.searchParams.get('token');
  const type = url.searchParams.get('type');

  const { data: verified, error: verifyError } = await adminClient.auth.verifyOtp({
    token_hash: tokenHash,
    type: type || 'magiclink'
  });

  if (verifyError) {
    console.error('Dev login verify error:', verifyError.message);
    return res.status(500).json({ error: 'Failed to verify dev session' });
  }

  console.log('Dev login: signed in as', email);
  res.json({
    session: {
      access_token: verified.session.access_token,
      refresh_token: verified.session.refresh_token,
      expires_at: verified.session.expires_at,
      user: {
        id: verified.user.id,
        email: verified.user.email
      }
    }
  });
});

module.exports = router;
module.exports.sendMagicLinkEmail = sendMagicLinkEmail;
