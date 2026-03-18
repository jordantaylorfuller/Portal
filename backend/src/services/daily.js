const config = require('../config');

const DAILY_API = 'https://api.daily.co/v1';

async function dailyFetch(path, opts = {}) {
  const res = await fetch(`${DAILY_API}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.DAILY_API_KEY}`,
      ...opts.headers
    }
  });
  const body = await res.json();
  if (!res.ok) {
    const msg = body.error || body.info || JSON.stringify(body);
    throw new Error(`Daily API ${res.status}: ${msg}`);
  }
  return body;
}

// Get or create a room for a project.
// Room name is derived from project ID to keep it stable.
async function getOrCreateRoom(projectId, projectName) {
  const roomName = `nipc-${projectId.slice(0, 8)}`;

  // Try to get existing room
  try {
    const room = await dailyFetch(`/rooms/${roomName}`);
    return room;
  } catch (err) {
    // Room doesn't exist, create it
  }

  const room = await dailyFetch('/rooms', {
    method: 'POST',
    body: JSON.stringify({
      name: roomName,
      privacy: 'private',
      properties: {
        exp: Math.floor(Date.now() / 1000) + 86400, // 24h from now
        max_participants: 20,
        enable_chat: true,
        enable_screenshare: true,
        enable_recording: 'cloud'
      }
    })
  });

  console.log(`Daily room created: ${room.url} for project "${projectName}"`);
  return room;
}

// Create a meeting token for a specific user + room.
async function createMeetingToken(roomName, { userName, userId, isOwner = false }) {
  const token = await dailyFetch('/meeting-tokens', {
    method: 'POST',
    body: JSON.stringify({
      properties: {
        room_name: roomName,
        user_name: userName || 'Guest',
        user_id: userId,
        is_owner: isOwner,
        exp: Math.floor(Date.now() / 1000) + 14400, // 4 hours
        enable_screenshare: true,
        start_video_off: false,
        start_audio_off: false
      }
    })
  });
  return token.token;
}

// List recordings for a specific room.
async function listRecordings(roomName) {
  const data = await dailyFetch(`/recordings?room_name=${encodeURIComponent(roomName)}`);
  return (data.data || []).map(function(r) {
    return {
      id: r.id,
      room_name: r.room_name,
      duration: r.duration,
      started_at: r.start_ts,
      status: r.status,
      max_participants: r.max_participants,
      tracks: r.tracks
    };
  });
}

// Get a signed access link for a recording.
async function getRecordingLink(recordingId) {
  const data = await dailyFetch(`/recordings/${recordingId}/access-link`);
  return data.download_link;
}

module.exports = { getOrCreateRoom, createMeetingToken, listRecordings, getRecordingLink };
