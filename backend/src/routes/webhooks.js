const { Router } = require('express');
const crypto = require('crypto');
const config = require('../config');
const { adminClient } = require('../services/supabase');

const router = Router();

// POST /api/webhooks/asana
// Handle Asana webhook events
router.post('/asana', async (req, res) => {
  // Asana handshake: respond with X-Hook-Secret header
  const hookSecret = req.headers['x-hook-secret'];
  if (hookSecret) {
    console.log('Asana webhook handshake received');
    res.set('X-Hook-Secret', hookSecret);
    return res.sendStatus(200);
  }

  // Verify HMAC signature if we have a stored secret
  const signature = req.headers['x-hook-signature'];
  if (config.ASANA_WEBHOOK_SECRET && signature) {
    const hmac = crypto.createHmac('sha256', config.ASANA_WEBHOOK_SECRET);
    hmac.update(JSON.stringify(req.body));
    const expected = hmac.digest('hex');
    if (signature !== expected) {
      console.error('Asana webhook signature mismatch');
      return res.sendStatus(401);
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

  res.sendStatus(200);
});

async function handleAsanaEvent(event) {
  const { resource, action, change, parent } = event;

  // Task custom field change -- client onboarding trigger
  if (resource.resource_type === 'task' && action === 'changed' &&
      change && change.field === 'custom_fields') {
    await handleTaskCustomFieldChange(event);
    return;
  }

  // Project sync: project changed
  if (resource.resource_type === 'project' && action === 'changed') {
    await handleProjectSync(event);
    return;
  }
}

// When a task's custom fields change, check if Client Email or Delivery URL was set
async function handleTaskCustomFieldChange(event) {
  if (!config.ASANA_PAT) return;

  const taskGid = event.resource.gid;

  // Fetch the task with its custom fields and project membership
  const taskResp = await fetch(
    `https://app.asana.com/api/1.0/tasks/${taskGid}?opt_fields=name,custom_fields.name,custom_fields.text_value,memberships.project.gid,memberships.project.name`,
    { headers: { Authorization: 'Bearer ' + config.ASANA_PAT } }
  );
  const taskData = await taskResp.json();
  const task = taskData.data;
  if (!task) return;

  const customFields = task.custom_fields || [];

  // Check for Delivery URL custom field -- sync delivery asset
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

  // Only proceed if there's a Client Email value
  if (!emailField || !emailField.text_value) return;

  const clientEmail = emailField.text_value.trim();
  if (!clientEmail || !clientEmail.includes('@')) return;

  const clientName = nameField && nameField.text_value ? nameField.text_value.trim() : '';
  const initials = clientName
    ? clientName.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
    : clientEmail.slice(0, 2).toUpperCase();

  // Get the project this task belongs to
  const membership = (task.memberships || [])[0];
  if (!membership || !membership.project) return;

  const projectGid = membership.project.gid;
  const projectName = membership.project.name;

  console.log(`Onboarding client: ${clientEmail} for project ${projectName}`);

  // Create or find Supabase user
  let userId;
  const { data: existingUsers } = await adminClient.auth.admin.listUsers();
  const existing = (existingUsers.users || []).find(u => u.email === clientEmail);

  if (existing) {
    userId = existing.id;
    console.log(`User already exists: ${userId}`);
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
    console.log(`Created new user: ${userId}`);

    // Create profile
    await adminClient.from('user_profiles').upsert({
      id: userId,
      display_name: clientName || clientEmail.split('@')[0],
      initials,
      role: 'client'
    });
  }

  // Upsert project record
  const { data: dbProject } = await adminClient
    .from('projects')
    .upsert(
      { asana_project_id: projectGid, name: projectName, status: 'active' },
      { onConflict: 'asana_project_id' }
    )
    .select('id')
    .single();

  if (dbProject) {
    // Link user to project
    await adminClient.from('project_members').upsert(
      { project_id: dbProject.id, user_id: userId, role: 'viewer' },
      { onConflict: 'project_id,user_id' }
    );
    console.log(`Linked user to project: ${dbProject.id}`);
  }

  // Generate magic link and send via Resend
  const { data: linkData, error: linkError } = await adminClient.auth.admin.generateLink({
    type: 'magiclink',
    email: clientEmail,
    options: { redirectTo: config.FRONTEND_ORIGIN }
  });

  if (linkError) {
    console.error('Failed to generate magic link:', linkError.message);
  } else if (config.RESEND_API_KEY) {
    const { sendMagicLinkEmail } = require('./auth');
    try {
      await sendMagicLinkEmail(clientEmail, linkData.properties.action_link);
      console.log(`Magic link email sent to ${clientEmail}`);
    } catch (err) {
      console.error('Failed to send magic link email:', err.message);
    }
  }
}

// Sync delivery asset from Asana task to Supabase
async function handleDeliverySync(task, customFields) {
  const taskGid = task.gid || task.resource?.gid;
  const membership = (task.memberships || [])[0];
  if (!membership || !membership.project) return;

  const projectGid = membership.project.gid;
  const projectName = membership.project.name;

  // Find or create the project in Supabase
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

  // Optional metadata fields from Asana custom fields
  const groupField = customFields.find(
    f => f.name && f.name.toLowerCase().includes('delivery group')
  );
  const sizeField = customFields.find(
    f => f.name && f.name.toLowerCase().includes('file size')
  );
  const specsField = customFields.find(
    f => f.name && f.name.toLowerCase().includes('file specs')
  );

  // Derive file type from URL or task name
  const title = task.name || 'Untitled';
  const ext = title.match(/\.(\w{2,4})$/)?.[1]?.toLowerCase() || '';
  const fileTypeMap = {
    mov: 'video', mp4: 'video', mxf: 'video', avi: 'video',
    wav: 'audio', aiff: 'audio', mp3: 'audio', aac: 'audio',
    pdf: 'document', zip: 'archive', rar: 'archive'
  };
  const fileType = fileTypeMap[ext] || 'file';

  const deliveryData = {
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
  };

  const { error } = await adminClient
    .from('delivery_assets')
    .upsert(deliveryData, { onConflict: 'asana_task_gid' });

  if (error) {
    console.error('Delivery sync error:', error.message);
  } else {
    console.log(`Delivery synced: "${title}" -> ${deliveryUrl} (project: ${projectName})`);
  }
}

// Sync project name/status from Asana to Supabase
async function handleProjectSync(event) {
  if (!config.ASANA_PAT) return;

  const projectGid = event.resource.gid;
  const projResp = await fetch(
    `https://app.asana.com/api/1.0/projects/${projectGid}?opt_fields=name,archived`,
    { headers: { Authorization: 'Bearer ' + config.ASANA_PAT } }
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

module.exports = router;
