#!/usr/bin/env node
// Watch the CMS data + build script and re-run `cms:pages` on change.
// Runs alongside `./serve.sh`. Also starts a small SSE server so the dev-only
// client in home/index.html can reload the browser after each rebuild.
//
// Port for SSE: (serve.sh port) + 100. serve.sh derives its port from a hash
// of the worktree path, so different worktrees get different reload ports.
// Override with WATCH_PORT=12345 if there's a collision.
//
// Usage: npm run dev

import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Watch the entire home/ tree. Events get classified by filename:
//   data/*.json   → rebuild (then reload after build)
//   *.css / *.js / *.html → reload only (vercel dev serves these fresh)
//   everything else (images, scrubber assets, .DS_Store) → ignored
// We watch the directory (not individual files) because fs.watch on a single
// file fires phantom `change` events on macOS whenever the file is read
// (atime update). Directory watches only fire on writes.
const TARGETS = [
  { path: join(ROOT, 'home'), recursive: true },
];

// State machine:
//   IDLE     — accepting events
//   BUILDING — build is running; ignore ALL events (the build itself writes
//              home/index.html + editors/* + works/*, which fs.watch surfaces
//              as `change` events)
//   COOLDOWN — build just finished; ignore events for LOCKOUT_MS so straggler
//              events from the build don't re-trigger
let state = 'IDLE';
let debounce = null;
let pendingAction = null;
const LOCKOUT_MS = 500;
const DEBOUNCE_MS = 100;

function classifyEvent(filename) {
  if (!filename) return null;
  // Normalize to forward slashes (Windows safety) and lowercase the extension.
  const f = String(filename).replace(/\\/g, '/');
  if (f.startsWith('data/') && f.endsWith('.json') && !f.includes('_draft')) {
    return 'rebuild';
  }
  if (f.endsWith('.css') || f.endsWith('.js') || f.endsWith('.html')) {
    return 'reload';
  }
  return null;
}

function build() {
  state = 'BUILDING';
  const t0 = Date.now();
  const proc = spawn('node', ['scripts/build-cms-pages.mjs'], { cwd: ROOT, stdio: 'inherit' });
  proc.on('exit', code => {
    const dt = Date.now() - t0;
    if (code === 0) {
      console.log(`[watch-cms] rebuilt in ${dt}ms — reloading browser`);
      notifyReload();
    } else {
      console.error(`[watch-cms] build failed (exit ${code})`);
    }
    state = 'COOLDOWN';
    setTimeout(() => { state = 'IDLE'; }, LOCKOUT_MS);
  });
}

function schedule(action) {
  if (state !== 'IDLE') return;
  // Rebuild trumps reload — if both fire in the same debounce window, we
  // build (which itself triggers a reload via notifyReload after success).
  if (pendingAction !== 'rebuild') pendingAction = action;
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => {
    debounce = null;
    const a = pendingAction;
    pendingAction = null;
    if (a === 'rebuild') build();
    else if (a === 'reload') {
      console.log('[watch-cms] file changed — reloading browser');
      notifyReload();
    }
  }, DEBOUNCE_MS);
}

// ── SSE reload server ──
// Browser clients (added by the inline script in home/index.html) hold an
// EventSource open to /__watch__. After each successful rebuild we send an
// `event: reload`, and the client calls location.reload().
const clients = new Set();
function notifyReload() {
  // Send the reload event AND close every connection. Node's `res.write()`
  // doesn't throw on a dead socket (data just goes into the kernel buffer
  // and gets dropped silently), so after the browser reloads once, the old
  // SSE connection sits in `clients` forever — the next reload then gets
  // "sent" to that ghost while the real new connection never fires. Closing
  // forces the browser's EventSource to reconnect (its retry: 1000 hint),
  // which gives us a clean live `clients` set for the next edit. */
  const before = clients.size;
  for (const r of clients) {
    try {
      r.write('event: reload\ndata: ok\n\n');
      r.end();
    } catch {}
  }
  clients.clear();
  console.log(`[watch-cms] notifyReload: pinged ${before} clients (cleared)`);
}

const SERVE_PORT_MIN = 5200;
const SERVE_PORT_RANGE = 799; // 5200–5999, mirrors serve.sh
const sha = createHash('sha1').update(ROOT).digest('hex').slice(0, 8);
const SERVE_PORT = SERVE_PORT_MIN + (parseInt(sha, 16) % SERVE_PORT_RANGE);
const RELOAD_PORT = Number(process.env.WATCH_PORT) || (SERVE_PORT + 100);

const server = createServer((req, res) => {
  if (req.url !== '/__watch__') { res.statusCode = 404; return res.end(); }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write('retry: 1000\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});
server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.warn(`[watch-cms] reload port ${RELOAD_PORT} in use — auto-refresh disabled`);
  } else {
    console.error(`[watch-cms] reload server error: ${err.message}`);
  }
});
server.listen(RELOAD_PORT, () => {
  console.log(`[watch-cms] reload server on http://localhost:${RELOAD_PORT}/__watch__`);
});

console.log('[watch-cms] watching home/ — Ctrl+C to stop');
for (const t of TARGETS) {
  try {
    watch(t.path, { recursive: t.recursive }, (event, filename) => {
      const action = classifyEvent(filename);
      if (action) schedule(action);
    });
  } catch (err) {
    console.error(`[watch-cms] cannot watch ${t.path}: ${err.message}`);
  }
}
// Skip the initial build when serve.sh launches us, since `vercel dev` runs
// `npm run build` on startup and we'd otherwise race the same output files.
if (!process.env.WATCH_SKIP_INITIAL) build();
