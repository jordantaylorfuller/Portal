// Treat any @nipc.tv email as an admin, in addition to anyone whose
// user_profiles.role is 'admin'. Used by auth gates and /api/auth/me so
// staff don't need explicit project_members rows to see the portal.

const ADMIN_EMAIL_DOMAIN = '@nipc.tv';

function isStaffEmail(email) {
  return typeof email === 'string' &&
         email.toLowerCase().endsWith(ADMIN_EMAIL_DOMAIN);
}

function isAdmin(profile, email) {
  if (profile && profile.role === 'admin') return true;
  return isStaffEmail(email);
}

module.exports = { isStaffEmail, isAdmin };
