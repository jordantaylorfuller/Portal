const crypto = require('crypto');
const { adminClient } = require('../../lib/supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Asana handshake: respond with X-Hook-Secret header
  const hookSecret = req.headers['x-hook-secret'];
  if (hookSecret) {
    console.log('Asana webhook handshake received');
    res.setHeader('X-Hook-Secret', hookSecret);
    return res.status(200).end();
  }

  // Verify HMAC signature if we have a stored secret
  const signature = req.headers['x-hook-signature'];
  if (process.env.ASANA_WEBHOOK_SECRET && signature) {
    const hmac = crypto.createHmac('sha256', process.env.ASANA_WEBHOOK_SECRET);
    hmac.update(JSON.stringify(req.body));
    const expected = hmac.digest('hex');
    if (signature !== expected) {
      console.error('Asana webhook signature mismatch');
      return res.status(401).end();
    }
  }

  const events = req.body.events || [];
  console.log(`Asana webhook: ${events.length} event(s)`);

  for (const event of events) {
    try {
      await handleAsanaEvent(event);
    } catch (err) {
      console.error('Error handling Asana event:', err.message);
    }
  }

  res.status(200).end();
};

async function handleAsanaEvent(event) {
  const { resource, action, change } = event;

  if (resource.resource_type === 'task' && action === 'changed' &&
      change && change.field === 'custom_fields') {
    await handleTaskCustomFieldChange(event);
    return;
  }

  if (resource.resource_type === 'project' && action === 'changed') {
    await handleProjectSync(event);
    return;
  }
}

async function handleTaskCustomFieldChange(event) {
  const pat = process.env.ASANA_PAT;
  if (!pat) return;

  const taskGid = event.resource.gid;

  const taskResp = await fetch(
    `https://app.asana.com/api/1.0/tasks/${taskGid}?opt_fields=name,custom_fields.name,custom_fields.text_value,memberships.project.gid,memberships.project.name`,
    { headers: { Authorization: 'Bearer ' + pat } }
  );
  const taskData = await taskResp.json();
  const task = taskData.data;
  if (!task) return;

  const customFields = task.custom_fields || [];

  // Check for Delivery URL custom field
  const deliveryUrlField = customFields.find(
    f => f.name && f.name.toLowerCase().includes('delivery url')
  );
  if (deliveryUrlField && deliveryUrlField.text_value && deliveryUrlField.text_value.trim()) {
    await handleDeliverySync(task, customFields);
  }

  const emailField = customFields.find(
    f => f.name && f.name.toLowerCase().includes('client email')
  );
  const nameField = customFields.find(
    f => f.name && f.name.toLowerCase().includes('client name')
  );

  if (!emailField || !emailField.text_value) return;

  const clientEmail = emailField.text_value.trim();
  if (!clientEmail || !clientEmail.includes('@')) return;

  const clientName = nameField && nameField.text_value ? nameField.text_value.trim() : '';
  const initials = clientName
    ? clientName.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
    : clientEmail.slice(0, 2).toUpperCase();

  const membership = (task.memberships || [])[0];
  if (!membership || !membership.project) return;

  const projectGid = membership.project.gid;
  const projectName = membership.project.name;

  console.log(`Onboarding client: ${clientEmail} for project ${projectName}`);

  let userId;
  const { data: existingUsers } = await adminClient.auth.admin.listUsers();
  const existing = (existingUsers.users || []).find(u => u.email === clientEmail);

  if (existing) {
    userId = existing.id;
  } else {
    const { data: newUser, error } = await adminClient.auth.admin.createUser({
      email: clientEmail,
      email_confirm: true,
      user_metadata: { display_name: clientName || clientEmail.split('@')[0] }
    });
    if (error) {
      console.error('Failed to create user:', error.message);
      return;
    }
    userId = newUser.user.id;

    await adminClient.from('user_profiles').upsert({
      id: userId,
      display_name: clientName || clientEmail.split('@')[0],
      initials,
      role: 'client'
    });
  }

  const { data: dbProject } = await adminClient
    .from('projects')
    .upsert(
      { asana_project_id: projectGid, name: projectName, status: 'active' },
      { onConflict: 'asana_project_id' }
    )
    .select('id')
    .single();

  if (dbProject) {
    await adminClient.from('project_members').upsert(
      { project_id: dbProject.id, user_id: userId, role: 'viewer' },
      { onConflict: 'project_id,user_id' }
    );
  }

  const frontendOrigin = process.env.FRONTEND_ORIGIN || process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}` : 'http://localhost:5920';

  const { data: linkData, error: linkError } = await adminClient.auth.admin.generateLink({
    type: 'magiclink',
    email: clientEmail,
    options: { redirectTo: frontendOrigin }
  });

  if (linkError) {
    console.error('Failed to generate magic link:', linkError.message);
  } else if (process.env.RESEND_API_KEY) {
    const { sendMagicLinkEmail } = require('../auth/magic-link');
    try {
      await sendMagicLinkEmail(clientEmail, linkData.properties.action_link);
      console.log(`Magic link email sent to ${clientEmail}`);
    } catch (err) {
      console.error('Failed to send magic link email:', err.message);
    }
  }
}

async function handleDeliverySync(task, customFields) {
  const taskGid = task.gid || task.resource?.gid;
  const membership = (task.memberships || [])[0];
  if (!membership || !membership.project) return;

  const projectGid = membership.project.gid;
  const projectName = membership.project.name;

  const { data: dbProject } = await adminClient
    .from('projects')
    .upsert(
      { asana_project_id: projectGid, name: projectName, status: 'active' },
      { onConflict: 'asana_project_id' }
    )
    .select('id')
    .single();

  if (!dbProject) return;

  const deliveryUrl = customFields.find(
    f => f.name && f.name.toLowerCase().includes('delivery url')
  ).text_value.trim();

  const groupField = customFields.find(f => f.name && f.name.toLowerCase().includes('delivery group'));
  const sizeField = customFields.find(f => f.name && f.name.toLowerCase().includes('file size'));
  const specsField = customFields.find(f => f.name && f.name.toLowerCase().includes('file specs'));

  const title = task.name || 'Untitled';
  const ext = title.match(/\.(\w{2,4})$/)?.[1]?.toLowerCase() || '';
  const fileTypeMap = {
    mov: 'video', mp4: 'video', mxf: 'video', avi: 'video',
    wav: 'audio', aiff: 'audio', mp3: 'audio', aac: 'audio',
    pdf: 'document', zip: 'archive', rar: 'archive'
  };
  const fileType = fileTypeMap[ext] || 'file';

  const { error } = await adminClient
    .from('delivery_assets')
    .upsert({
      project_id: dbProject.id,
      asana_task_gid: taskGid,
      title,
      url: deliveryUrl,
      file_type: fileType,
      file_size: sizeField?.text_value?.trim() || null,
      specs: specsField?.text_value?.trim() || null,
      group_name: groupField?.text_value?.trim() || 'Files',
      status: 'ready',
      updated_at: new Date().toISOString()
    }, { onConflict: 'asana_task_gid' });

  if (error) {
    console.error('Delivery sync error:', error.message);
  } else {
    console.log(`Delivery synced: "${title}" -> ${deliveryUrl} (project: ${projectName})`);
  }
}

async function handleProjectSync(event) {
  const pat = process.env.ASANA_PAT;
  if (!pat) return;

  const projectGid = event.resource.gid;
  const projResp = await fetch(
    `https://app.asana.com/api/1.0/projects/${projectGid}?opt_fields=name,archived`,
    { headers: { Authorization: 'Bearer ' + pat } }
  );
  const projData = await projResp.json();
  const project = projData.data;
  if (!project) return;

  await adminClient.from('projects').upsert(
    {
      asana_project_id: projectGid,
      name: project.name,
      status: project.archived ? 'archived' : 'active'
    },
    { onConflict: 'asana_project_id' }
  );

  console.log(`Synced project: ${project.name}`);
}
