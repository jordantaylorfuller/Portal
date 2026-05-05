const { adminClient } = require('../../lib/supabase');
const { getBusy, createEvent, TZ, HOST_EMAIL } = require('../../lib/gcal');

// Public scheduler. Single-segment routes only (Vercel catch-all quirk).
//   GET  /api/scheduler/availability?date=YYYY-MM-DD
//   POST /api/scheduler/book          { name, email, start, end, reel_slug?, message? }

const SLOT_MIN = 30;          // minutes per slot
const DAY_START_HOUR = 9;     // 9am ET
const DAY_END_HOUR   = 18;    // 6pm ET
const WORKING_DAYS = new Set([1, 2, 3, 4, 5]); // Mon-Fri

module.exports = async function handler(req, res) {
  const raw = req.query.path || req.query['...path'];
  const segments = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const route = segments[0] || '';

  try {
    if (route === 'availability' && req.method === 'GET') return availability(req, res);
    if (route === 'book' && req.method === 'POST')         return book(req, res);
    return res.status(404).json({ error: 'Not found', route, method: req.method });
  } catch (err) {
    console.error('scheduler error:', err.message, err.stack);
    if (/GOOGLE_SA_JSON not configured/.test(err.message)) {
      return res.status(503).json({ error: 'Scheduler not configured' });
    }
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
};

function parseLocalDate(dateStr) {
  // Returns midnight-local Date for the given YYYY-MM-DD in the configured TZ.
  // We use Intl + Date trickery: build a UTC midnight and shift to the TZ offset.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  if (!m) return null;
  const utcMidnight = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  // Offset of TZ at that date in minutes:
  const tzOffsetMin = tzOffsetMinutes(utcMidnight);
  return new Date(utcMidnight.getTime() - tzOffsetMin * 60 * 1000);
}

function tzOffsetMinutes(date) {
  // Compute TZ offset (minutes) between UTC and configured TZ at the given instant.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  const asUTC = Date.UTC(
    +parts.year, +parts.month - 1, +parts.day,
    +parts.hour % 24, +parts.minute, +parts.second
  );
  return (asUTC - date.getTime()) / 60000;
}

function isoLocal(date) {
  // ISO 8601 with a numeric offset for the configured TZ.
  const off = tzOffsetMinutes(date);
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  const local = new Date(date.getTime() + off * 60000);
  const iso = local.toISOString().replace('Z', '');
  return iso.slice(0, 19) + sign + hh + ':' + mm;
}

async function availability(req, res) {
  const dayStart = parseLocalDate(req.query.date);
  if (!dayStart) return res.status(400).json({ error: 'date=YYYY-MM-DD required' });

  // Build list of candidate slots for the day (working hours + working days only)
  const candidates = [];
  const dow = Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' })
    .format(dayStart).match(/Mon|Tue|Wed|Thu|Fri|Sat|Sun/) ? null : null);
  // Reliable DOW: read the local weekday name then map.
  const weekdayName = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(dayStart);
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dowReal = weekdayMap[weekdayName] ?? 0;

  if (!WORKING_DAYS.has(dowReal)) {
    return res.json({ date: req.query.date, timezone: TZ, slots: [] });
  }

  // Build slots from DAY_START_HOUR to DAY_END_HOUR in SLOT_MIN steps.
  const startMs = dayStart.getTime() + DAY_START_HOUR * 3600 * 1000;
  const endMs   = dayStart.getTime() + DAY_END_HOUR * 3600 * 1000;
  for (let t = startMs; t + SLOT_MIN * 60000 <= endMs; t += SLOT_MIN * 60000) {
    candidates.push({ start: new Date(t), end: new Date(t + SLOT_MIN * 60000) });
  }

  // Pull busy intervals for the day from hi@nipc.tv
  const busy = await getBusy(new Date(startMs), new Date(endMs));
  const now = Date.now();

  const slots = candidates
    .filter(s => s.start.getTime() > now + 30 * 60000) // require at least 30 min lead
    .filter(s => !busy.some(b => s.start < b.end && s.end > b.start))
    .map(s => ({ start: isoLocal(s.start), end: isoLocal(s.end) }));

  res.json({ date: req.query.date, timezone: TZ, slots });
}

async function book(req, res) {
  const { name, email, start, end, reel_slug, message } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'valid email required' });
  }
  if (!start || !end) return res.status(400).json({ error: 'start and end required' });

  const startD = new Date(start);
  const endD = new Date(end);
  if (isNaN(startD) || isNaN(endD) || endD <= startD) {
    return res.status(400).json({ error: 'invalid time range' });
  }
  if (startD.getTime() < Date.now() + 25 * 60000) {
    return res.status(400).json({ error: 'must be at least 30 minutes in the future' });
  }

  // Re-verify the slot is still free (race-safe-ish)
  const busy = await getBusy(startD, endD);
  if (busy.some(b => startD < b.end && endD > b.start)) {
    return res.status(409).json({ error: 'slot just got taken — pick another' });
  }

  // Look up reel context if a slug was passed (so the event description has it)
  let reelContext = '';
  if (reel_slug) {
    const { data: reel } = await adminClient.from('reels')
      .select('title, slug').eq('slug', reel_slug).maybeSingle();
    if (reel) reelContext = '\nReel: ' + reel.title + '  ·  ' + 'https://atlanta-beta.vercel.app/reel.html?s=' + reel.slug;
  }

  const summary = 'NIPC intro call' + (name ? ' — ' + name : '');
  const description =
    'Booked via the NIPC reels portal.\n' +
    'Visitor: ' + (name || '(no name)') + '  <' + email + '>' +
    reelContext +
    (message ? '\n\nMessage:\n' + message : '');

  const ev = await createEvent({
    summary, description,
    start: startD, end: endD,
    visitorEmail: email,
    visitorName: name,
  });

  res.json({ ok: true, event_id: ev.id, meet_link: ev.meetLink, html_link: ev.htmlLink });
}
