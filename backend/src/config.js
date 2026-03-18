const path = require('path');
const fs = require('fs');

// Load .env file if present
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx);
    const val = trimmed.slice(eqIdx + 1);
    if (!process.env[key]) process.env[key] = val;
  }
}

const required = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_ANON_KEY'
];

const missing = required.filter(k => !process.env[k]);
if (missing.length) {
  throw new Error('Missing required env vars: ' + missing.join(', '));
}

module.exports = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
  ASANA_PAT: process.env.ASANA_PAT,
  ASANA_WEBHOOK_SECRET: process.env.ASANA_WEBHOOK_SECRET,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  DAILY_API_KEY: process.env.DAILY_API_KEY,
  FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN || 'http://localhost:5920',
  PORT: parseInt(process.env.PORT, 10) || 8080
};
