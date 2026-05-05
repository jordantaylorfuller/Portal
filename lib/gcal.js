const { google } = require('googleapis');

const TZ = process.env.NIPC_TIMEZONE || 'America/New_York';
const HOST_EMAIL = process.env.NIPC_HOST_EMAIL || 'hi@nipc.tv';

let _client;

function getClient() {
  if (_client) return _client;
  const raw = process.env.GOOGLE_SA_JSON;
  if (!raw) throw new Error('GOOGLE_SA_JSON not configured');
  let creds;
  try {
    creds = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
  } catch (e) {
    throw new Error('GOOGLE_SA_JSON is not valid JSON or base64-JSON');
  }
  const jwt = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/calendar'],
    subject: HOST_EMAIL,
  });
  _client = google.calendar({ version: 'v3', auth: jwt });
  return _client;
}

async function getBusy(timeMin, timeMax) {
  const cal = getClient();
  const r = await cal.freebusy.query({
    requestBody: {
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      timeZone: TZ,
      items: [{ id: HOST_EMAIL }],
    },
  });
  return (r.data.calendars?.[HOST_EMAIL]?.busy || []).map(b => ({
    start: new Date(b.start),
    end: new Date(b.end),
  }));
}

async function createEvent({ summary, description, start, end, visitorEmail, visitorName }) {
  const cal = getClient();
  const r = await cal.events.insert({
    calendarId: HOST_EMAIL,
    conferenceDataVersion: 1,
    sendUpdates: 'all',
    requestBody: {
      summary,
      description,
      start: { dateTime: start.toISOString(), timeZone: TZ },
      end:   { dateTime: end.toISOString(),   timeZone: TZ },
      attendees: [
        { email: HOST_EMAIL },
        { email: visitorEmail, displayName: visitorName || undefined },
      ],
      conferenceData: {
        createRequest: {
          requestId: 'reels-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      },
    },
  });
  const ev = r.data;
  const meetLink = (ev.conferenceData?.entryPoints || []).find(e => e.entryPointType === 'video')?.uri || null;
  return { id: ev.id, htmlLink: ev.htmlLink, meetLink };
}

module.exports = { getBusy, createEvent, TZ, HOST_EMAIL };
