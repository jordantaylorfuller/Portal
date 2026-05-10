// GET    /api/projects/:projectId/members             — admin: list members.
// POST   /api/projects/:projectId/members             — admin: invite by email.
//   body: { email, role?: 'viewer' | 'admin' }  (role defaults to 'viewer')
//   - If auth.users row missing: admin.createUser(email_confirm=true) creates it.
//   - Upsert project_members (idempotent re-invite). Trigger increments members_count.
//   - Send a branded Resend email with a NON-EXPIRING portal URL:
//       ${frontendOrigin}/?invite=<email>&project=<projectId>
//     When the invitee clicks the link, index.html requests a fresh magic-link
//     and routes them to the "check your email" screen. The membership row and
//     the invite URL itself never expire; only the per-click magic link does
//     (and a new one can be issued any time by re-clicking the invite link).
//   Returns { ok, member, invited, email_sent }.
// DELETE /api/projects/:projectId/members?user=<user_id> — admin: remove one membership.
//   Trigger decrements members_count. auth.users row is NOT deleted.

const { requireAdmin } = require('../../../lib/frameio-admin');
const { adminClient } = require('../../../lib/supabase');
const { resolveFrontendOrigin } = require('../../../lib/origin');

module.exports = async function handler(req, res) {
  if (!(await requireAdmin(req, res))) return;

  const { projectId } = req.query;
  if (!projectId) return res.status(400).json({ error: 'projectId required' });

  if (req.method === 'GET') {
    return listMembers(req, res, projectId);
  }
  if (req.method === 'POST') {
    return inviteMember(req, res, projectId);
  }
  if (req.method === 'DELETE') {
    return removeMember(req, res, projectId);
  }
  return res.status(405).json({ error: 'Method not allowed' });
};

async function listMembers(req, res, projectId) {
  const { data: rows, error } = await adminClient
    .from('project_members')
    .select('user_id, role, added_at')
    .eq('project_id', projectId)
    .order('added_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });

  const userIds = (rows || []).map(r => r.user_id);
  if (userIds.length === 0) return res.json({ members: [] });

  const { data: profiles } = await adminClient
    .from('user_profiles')
    .select('id, display_name')
    .in('id', userIds);
  const nameById = new Map((profiles || []).map(p => [p.id, p.display_name]));

  const members = await Promise.all((rows || []).map(async (r) => {
    let email = null;
    try {
      const { data: u } = await adminClient.auth.admin.getUserById(r.user_id);
      email = u && u.user ? u.user.email : null;
    } catch (_) { /* ignore — show row anyway */ }
    return {
      user_id: r.user_id,
      email,
      display_name: nameById.get(r.user_id) || null,
      role: r.role,
      added_at: r.added_at
    };
  }));

  return res.json({ members });
}

async function inviteMember(req, res, projectId) {
  const body = req.body || {};
  const rawEmail = (body.email || '').trim().toLowerCase();
  if (!rawEmail || !rawEmail.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }
  const role = body.role === 'admin' ? 'admin' : 'viewer';

  // Verify the project exists and pull its name for the email body.
  const { data: project, error: projectError } = await adminClient
    .from('projects')
    .select('id, name, display_name')
    .eq('id', projectId)
    .maybeSingle();
  if (projectError) return res.status(500).json({ error: projectError.message });
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const projectLabel = project.display_name || project.name || 'your project';

  // Find or create the auth user. We deliberately don't generate a magic link
  // here — the invite email points to a persistent URL that issues fresh links
  // on click, so the invitation itself can sit in an inbox indefinitely.
  let userId;
  let invited = false;
  try {
    let existing = await findUserByEmail(rawEmail);
    if (existing) {
      userId = existing.id;
    } else {
      const { data: created, error: createError } = await adminClient.auth.admin.createUser({
        email: rawEmail,
        email_confirm: true
      });
      if (createError) {
        // Common case: the user already exists but our paged search missed
        // them due to ordering / new signup between calls. Re-resolve before
        // giving up.
        const retry = await findUserByEmail(rawEmail);
        if (retry) {
          userId = retry.id;
        } else {
          console.error('createUser failed:', createError.message);
          return res.status(500).json({ error: 'Failed to create user: ' + createError.message });
        }
      } else {
        userId = created.user.id;
        invited = true;
      }
    }
  } catch (err) {
    console.error('User lookup/create failed:', err.message);
    return res.status(500).json({ error: 'Failed to resolve invitee' });
  }

  // Upsert membership (idempotent — re-inviting an existing member just refreshes
  // the row without triggering the count increment again).
  const { error: memberError } = await adminClient
    .from('project_members')
    .upsert(
      { project_id: projectId, user_id: userId, role },
      { onConflict: 'project_id,user_id' }
    );
  if (memberError) {
    console.error('project_members upsert failed:', memberError.message);
    return res.status(500).json({ error: memberError.message });
  }

  // Compose the persistent invite URL. Origin selection:
  //   - production: pin to FRONTEND_ORIGIN (stable atlanta-beta URL) so emails
  //     from prod always land users on prod.
  //   - preview:    use the per-deployment VERCEL_URL so invitations from a
  //     branch preview exercise that branch's code, not stale prod code.
  //   - local dev:  use the request's own host so URLs work on the same machine.
  const frontendOrigin = resolveFrontendOrigin(req);
  const inviteUrl =
    `${frontendOrigin}/?invite=${encodeURIComponent(rawEmail)}` +
    `&project=${encodeURIComponent(projectId)}`;

  let emailSent = false;
  if (process.env.RESEND_API_KEY) {
    try {
      await sendInvitationEmail({ email: rawEmail, inviteUrl, projectLabel });
      emailSent = true;
    } catch (err) {
      console.error('Resend invite send failed:', err.message);
    }
  }

  // Re-fetch the member row so the UI gets the same shape as listMembers().
  const { data: profile } = await adminClient
    .from('user_profiles')
    .select('display_name')
    .eq('id', userId)
    .maybeSingle();
  const { data: pm } = await adminClient
    .from('project_members')
    .select('added_at, role')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .maybeSingle();

  return res.json({
    ok: true,
    invited,
    email_sent: emailSent,
    invite_url: inviteUrl,
    member: {
      user_id: userId,
      email: rawEmail,
      display_name: profile ? profile.display_name : null,
      role: pm ? pm.role : role,
      added_at: pm ? pm.added_at : null
    }
  });
}

async function removeMember(req, res, projectId) {
  const userId = (req.query && req.query.user) || (req.body && req.body.user_id);
  if (!userId) return res.status(400).json({ error: 'user_id required' });

  const { error } = await adminClient
    .from('project_members')
    .delete()
    .eq('project_id', projectId)
    .eq('user_id', userId);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
}

// Walk every page of auth.users — `listUsers()` returns 50 per page by
// default and silently truncates, so a single call misses users on later
// pages once the workspace grows.
async function findUserByEmail(email) {
  const needle = email.toLowerCase();
  const perPage = 1000;
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await adminClient.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(error.message);
    const users = (data && data.users) || [];
    const hit = users.find(u => u.email && u.email.toLowerCase() === needle);
    if (hit) return hit;
    if (users.length < perPage) return null;
  }
  return null;
}

function buildInvitationEmail({ inviteUrl, projectLabel }) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#111;font-family:'DM Mono',Menlo,Consolas,monospace;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#111;">
<tr><td align="center" style="padding:48px 24px;">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;">
<tr><td style="font-size:14px;color:#ffffff;line-height:1.6;padding-bottom:18px;">
You have been invited to review <strong style="color:#fff;">${escapeHtml(projectLabel)}</strong> on the NIPC Portal.
</td></tr>
<tr><td style="font-size:12px;color:#999;line-height:1.6;padding-bottom:28px;">
Click below to sign in. The portal will email you a fresh single-use sign-in link each time you open it.
</td></tr>
<tr><td style="padding-bottom:36px;">
<a href="${inviteUrl}" style="display:inline-block;padding:12px 28px;background:#cc3333;color:#ffffff;text-decoration:none;font-family:'DM Mono',Menlo,Consolas,monospace;font-size:13px;font-weight:400;letter-spacing:0.05em;">OPEN PROJECT</a>
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

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

async function sendInvitationEmail({ email, inviteUrl, projectLabel }) {
  const subject = `You're invited to review ${projectLabel} on NIPC Portal`;
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
      html: buildInvitationEmail({ inviteUrl, projectLabel })
    })
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(JSON.stringify(data));
  return data;
}
