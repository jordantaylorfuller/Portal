const { getAuthUser } = require('../../lib/auth');
const { adminClient } = require('../../lib/supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await getAuthUser(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const { firstName, lastName } = req.body;
  if (!firstName) return res.status(400).json({ error: 'First name is required' });

  const displayName = firstName.trim();
  const fullName = lastName ? `${firstName.trim()} ${lastName.trim()}` : displayName;
  const initials = lastName
    ? (firstName[0] + lastName[0]).toUpperCase()
    : firstName.slice(0, 2).toUpperCase();

  const { error: profileError } = await adminClient.from('user_profiles').upsert({
    id: auth.id,
    display_name: displayName,
    initials,
    role: 'client'
  });

  if (profileError) {
    console.error('Profile upsert error:', profileError.message);
    return res.status(500).json({ error: 'Failed to save profile' });
  }

  if (process.env.ASANA_PAT) {
    try {
      await syncAsanaContact(auth.email, fullName);
    } catch (err) {
      console.error('Asana sync error:', err.message);
    }
  }

  res.json({ displayName, initials });
};

async function syncAsanaContact(email, fullName) {
  const workspaceGid = '1213458026214848';
  const pat = process.env.ASANA_PAT;

  const searchResp = await fetch(
    `https://app.asana.com/api/1.0/workspaces/${workspaceGid}/tasks/search?text=${encodeURIComponent(email)}&opt_fields=name,custom_fields.name,custom_fields.text_value,custom_fields.gid`,
    { headers: { Authorization: 'Bearer ' + pat } }
  );
  const searchData = await searchResp.json();
  const tasks = searchData.data || [];

  for (const task of tasks) {
    const emailField = (task.custom_fields || []).find(
      f => f.name && f.name.toLowerCase().includes('client email') && f.text_value === email
    );
    if (emailField) {
      const nameField = (task.custom_fields || []).find(
        f => f.name && f.name.toLowerCase().includes('client name')
      );
      if (nameField) {
        await fetch(`https://app.asana.com/api/1.0/tasks/${task.gid}`, {
          method: 'PUT',
          headers: {
            Authorization: 'Bearer ' + pat,
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
