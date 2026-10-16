#!/usr/bin/env node
// intermission-probe.mjs: measures how a Plex server and its players report playback.
//
// Lists players, logs every webhook and server notification, tracks the session position and shows the
// credits markers of whatever is playing. Used to design and verify the plugin's timing.
// No dependencies; Node 22 or later.
//
// Usage:
//   PLEX_TOKEN=xxxx node intermission-probe.mjs players
//   PLEX_TOKEN=xxxx node intermission-probe.mjs prefs     (Plex Pass, webhooks, credits settings, marker coverage; read only)
//   PLEX_TOKEN=xxxx node intermission-probe.mjs watch [--player "Apple TV"] [--interval 1000] [--port 32599]
//
// Options:
//   --url       Plex server URL (default http://127.0.0.1:32400)
//   --player    only report this player (title or machineIdentifier, case-insensitive)
//   --interval  session poll interval in ms for the measurement (default 1000, min 250)
//   --port      webhook listener port (default 32599); 0 disables the listener
//   --log       JSONL log file (default ./intermission-probe-<timestamp>.jsonl)
//   --no-ws     do not listen to server notifications
//
// The token is read only from the PLEX_TOKEN environment variable and is never printed or logged.

import http from 'node:http';
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// args
const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('--') ? argv.shift() : 'watch';
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};
const BASE = opt('url', 'http://127.0.0.1:32400').replace(/\/+$/, '');
const PLAYER = (opt('player', '') || '').toLowerCase();
const INTERVAL = Math.max(250, Number(opt('interval', 1000)) || 1000);
const PORT = Number(opt('port', 32599));
const LOG = opt('log', `./intermission-probe-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
const TOKEN = process.env.PLEX_TOKEN || '';
const CLIENT_ID = `intermission-probe-${randomUUID()}`;

if (!TOKEN) {
  console.error('Set PLEX_TOKEN in the environment first (see README notes in the chat).');
  process.exit(1);
}
if (!['players', 'watch', 'prefs'].includes(cmd)) {
  console.error(`Unknown command "${cmd}". Use: players | prefs | watch`);
  process.exit(1);
}

// helpers
const now = () => Date.now();
const iso = (t = now()) => new Date(t).toISOString();
const clock = (t = now()) => new Date(t).toTimeString().slice(0, 8) + '.' + String(t % 1000).padStart(3, '0');
const hms = (ms) => {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return '?';
  const neg = ms < 0; ms = Math.abs(ms);
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${neg ? '-' : ''}${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
};
const num = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));
const log = (type, data) => {
  try { appendFileSync(LOG, JSON.stringify({ t: iso(), type, ...data }) + '\n'); } catch { /* best effort */ }
};

async function plex(path, base = BASE) {
  const res = await fetch(base + path, {
    headers: {
      'X-Plex-Token': TOKEN,
      'X-Plex-Client-Identifier': CLIENT_ID,
      'X-Plex-Product': 'intermission-probe',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${path.split('?')[0]}`);
  return res.json();
}

const matchesPlayer = (title, uuid) =>
  !PLAYER || (title || '').toLowerCase() === PLAYER || (uuid || '').toLowerCase() === PLAYER;

// players
async function listPlayers() {
  try {
    const id = await plex('/identity');
    console.log(`Server: ${BASE}  machineIdentifier=${id.MediaContainer?.machineIdentifier}  version=${id.MediaContainer?.version}\n`);
  } catch (e) { console.log(`Server identity failed: ${e.message}\n`); }

  console.log('Active sessions (play something on each device you want listed):');
  try {
    const s = await plex('/status/sessions');
    const items = s.MediaContainer?.Metadata ?? [];
    if (!items.length) console.log('  (none playing)');
    for (const m of items) {
      const p = m.Player ?? {};
      console.log(`  ${p.title} | product=${p.product} | platform=${p.platform} | uuid=${p.machineIdentifier} | user=${m.User?.title} | state=${p.state}`);
    }
  } catch (e) { console.log(`  failed: ${e.message}`); }

  console.log('\nLocally discovered clients (/clients):');
  try {
    const c = await plex('/clients');
    const servers = c.MediaContainer?.Server ?? [];
    if (!servers.length) console.log('  (none; Apple TV often does not appear here, that is normal)');
    for (const d of servers) console.log(`  ${d.name} | product=${d.product} | uuid=${d.machineIdentifier} | ${d.host}:${d.port}`);
  } catch (e) { console.log(`  failed: ${e.message}`); }

  console.log('\nPlayers registered to your Plex account (plex.tv):');
  try {
    const r = await plex('/api/v2/resources?includeHttps=1', 'https://plex.tv');
    const players = (Array.isArray(r) ? r : []).filter((d) => /player|client/.test(d.provides || ''));
    if (!players.length) console.log('  (none returned)');
    for (const d of players) {
      const seen = d.lastSeenAt ? new Date(d.lastSeenAt).toISOString().slice(0, 10) : '?';
      console.log(`  ${d.name} | product=${d.product} | platform=${d.platform} | uuid=${d.clientIdentifier} | lastSeen=${seen}`);
    }
  } catch (e) { console.log(`  failed: ${e.message}`); }

  console.log('\nAll devices signed in to your Plex account (plex.tv devices.xml):');
  try {
    const res = await fetch('https://plex.tv/devices.xml', {
      headers: { 'X-Plex-Token': TOKEN, 'X-Plex-Client-Identifier': CLIENT_ID },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const attr = (tag, name) => (new RegExp(`\\s${name}="([^"]*)"`).exec(tag) || [])[1] || '';
    const devices = [...xml.matchAll(/<Device\s[^>]*>/g)].map((m) => m[0])
      .filter((tag) => /player|client/.test(attr(tag, 'provides')));
    if (!devices.length) console.log('  (no player devices returned)');
    for (const tag of devices) {
      const seen = Number(attr(tag, 'lastSeenAt'));
      const date = seen ? new Date(seen * 1000).toISOString().slice(0, 10) : '?';
      console.log(`  ${attr(tag, 'name')} | product=${attr(tag, 'product')} | platform=${attr(tag, 'platform')} | uuid=${attr(tag, 'clientIdentifier')} | lastSeen=${date}`);
    }
  } catch (e) { console.log(`  failed: ${e.message}`); }

  console.log('\nRecent players from server history (last 200 plays):');
  try {
    const names = new Map();
    try {
      const d = await plex('/devices');
      for (const dev of d.MediaContainer?.Device ?? []) names.set(String(dev.id), dev);
    } catch { /* optional */ }
    const h = await plex('/status/sessions/history/all?sort=viewedAt:desc&X-Plex-Container-Start=0&X-Plex-Container-Size=200');
    const seen = new Map();
    for (const m of h.MediaContainer?.Metadata ?? []) {
      const key = String(m.deviceID);
      if (!seen.has(key)) seen.set(key, { count: 0, last: m.viewedAt });
      seen.get(key).count++;
    }
    if (!seen.size) console.log('  (no history)');
    for (const [id, info] of seen) {
      const dev = names.get(id);
      const last = info.last ? new Date(info.last * 1000).toISOString().slice(0, 10) : '?';
      console.log(`  ${dev?.name ?? `device ${id}`} | platform=${dev?.platform ?? '?'} | uuid=${dev?.clientIdentifier ?? '?'} | plays=${info.count} | last=${last}`);
    }
  } catch (e) { console.log(`  failed: ${e.message}`); }
}

// prefs
async function showPrefs() {
  console.log('Plex account (plex.tv):');
  try {
    const u = await plex('/api/v2/user', 'https://plex.tv');
    const sub = u.subscription ?? {};
    console.log(`  user=${u.username ?? u.title} | Plex Pass active=${sub.active} | plan=${sub.plan ?? '?'} | status=${sub.status ?? '?'}`);
  } catch (e) { console.log(`  failed: ${e.message}`); }

  console.log('\nWebhooks registered on your account (read only, nothing is changed):');
  try {
    const w = await plex('/api/v2/user/webhooks', 'https://plex.tv');
    const list = Array.isArray(w) ? w : (w.webhooks ?? w.MediaContainer?.Webhook ?? []);
    if (!list.length) console.log(`  (none, or unexpected shape: ${JSON.stringify(w).slice(0, 200)})`);
    for (const x of list) console.log(`  ${typeof x === 'string' ? x : x.url ?? JSON.stringify(x)}`);
  } catch (e) { console.log(`  failed: ${e.message}`); }

  console.log('\nServer preferences relevant to Intermission (/:/prefs):');
  try {
    const p = await plex('/:/prefs');
    const rx = /credit|intro|marker|played|threshold|completion|webhook|scrobble|resume|rewind/i;
    const hits = (p.MediaContainer?.Setting ?? []).filter((s) => rx.test(`${s.id} ${s.label} ${s.summary}`));
    if (!hits.length) console.log('  (no matching settings found)');
    for (const s of hits) {
      console.log(`  ${s.id} = ${JSON.stringify(s.value)}   (default ${JSON.stringify(s.default)})`);
      console.log(`      ${s.label}${s.enumValues ? `  options: ${s.enumValues}` : ''}`);
    }
  } catch (e) { console.log(`  failed: ${e.message}`); }

  console.log('\nLibraries and credits-marker coverage (sample of 25 recently added items each):');
  try {
    const secs = (await plex('/library/sections')).MediaContainer?.Directory ?? [];
    for (const sec of secs.filter((x) => x.type === 'movie' || x.type === 'show')) {
      const type = sec.type === 'show' ? 4 : 1; // episodes for shows, movies for movie libraries
      const r = await plex(`/library/sections/${sec.key}/recentlyAdded?type=${type}&X-Plex-Container-Start=0&X-Plex-Container-Size=25`);
      const items = r.MediaContainer?.Metadata ?? [];
      let withCredits = 0;
      for (const it of items) {
        const mk = await markersFor(it.ratingKey);
        if (mk?.credits?.length) withCredits++;
      }
      console.log(`  ${sec.title} (${sec.type}, key ${sec.key}): ${withCredits}/${items.length} sampled items have credits markers`);
    }
  } catch (e) { console.log(`  failed: ${e.message}`); }
}

// watch
const markerCache = new Map(); // ratingKey -> { credits: [...], intro: [...] } | null
const state = new Map(); // playerUuid -> tracking
const hooks = new Map(); // playerUuid -> { event, t }
const hookCounts = {};

async function markersFor(ratingKey) {
  if (markerCache.has(ratingKey)) return markerCache.get(ratingKey);
  let result = null;
  try {
    const r = await plex(`/library/metadata/${encodeURIComponent(ratingKey)}?includeMarkers=1`);
    const marks = (r.MediaContainer?.Metadata ?? []).flatMap((x) => x.Marker ?? []);
    result = {
      credits: marks.filter((m) => m.type === 'credits').map((m) => ({ start: num(m.startTimeOffset), end: num(m.endTimeOffset), final: !!m.final })),
      intro: marks.filter((m) => m.type === 'intro').map((m) => ({ start: num(m.startTimeOffset), end: num(m.endTimeOffset) })),
    };
  } catch (e) {
    console.log(`${clock()} MARKERS failed for ratingKey ${ratingKey}: ${e.message}`);
  }
  markerCache.set(ratingKey, result);
  return result;
}

async function pollOnce() {
  let items;
  try {
    items = (await plex('/status/sessions')).MediaContainer?.Metadata ?? [];
  } catch (e) {
    console.log(`${clock()} POLL error: ${e.message}`);
    return;
  }
  const t = now();
  const seen = new Set();
  for (const m of items) {
    const p = m.Player ?? {};
    const uuid = p.machineIdentifier;
    if (!uuid || !matchesPlayer(p.title, uuid)) continue;
    seen.add(uuid);
    const pos = num(m.viewOffset);
    const dur = num(m.duration);
    const title = m.grandparentTitle ? `${m.grandparentTitle} - ${m.title}` : m.title;
    let s = state.get(uuid);

    if (!s || s.ratingKey !== m.ratingKey) {
      const mk = await markersFor(m.ratingKey);
      s = { ratingKey: m.ratingKey, title, player: p.title, pos, posAt: t, st: p.state, intervals: s?.intervals ?? [], updates: s?.updates ?? 0, mk };
      state.set(uuid, s);
      const credits = mk?.credits?.length ? mk.credits.map((c) => `${hms(c.start)}${c.final ? ' (final)' : ''}`).join(', ') : 'NONE';
      console.log(`\n${clock()} NOW PLAYING on ${p.title} [${uuid}]: ${title} (${m.type}, ratingKey ${m.ratingKey}, user ${m.User?.title})`);
      console.log(`             duration ${hms(dur)} | credits markers: ${credits} | intro: ${mk?.intro?.length ? mk.intro.map((i) => hms(i.start)).join(', ') : 'none'}`);
      log('item', { uuid, player: p.title, ratingKey: m.ratingKey, mediaType: m.type, title, duration: dur, markers: mk, user: m.User?.title });
      continue;
    }

    if (p.state !== s.st) {
      const h = hooks.get(uuid);
      const lag = h && t - h.t < 60000 ? ` (${t - h.t} ms after webhook ${h.event})` : '';
      console.log(`${clock()} STATE ${s.st} -> ${p.state} at ${hms(pos)}${lag}`);
      log('state', { uuid, from: s.st, to: p.state, pos, webhookLagMs: h ? t - h.t : null, webhookEvent: h?.event });
      s.st = p.state;
    }

    if (pos !== s.pos) {
      const wall = t - s.posAt;
      const jump = pos - s.pos;
      s.updates++;
      if (s.st === 'playing' && wall < 120000) s.intervals.push(wall);
      const firstCredit = s.mk?.credits?.length ? Math.min(...s.mk.credits.map((c) => c.start)) : undefined;
      const toCredits = firstCredit !== undefined ? ` | credits in ${hms(firstCredit - pos)}` : '';
      const seek = Math.abs(jump - wall) > 15000 ? '  <-- SEEK?' : '';
      console.log(`${clock()} POS ${hms(pos)} (+${(jump / 1000).toFixed(1)}s position in ${(wall / 1000).toFixed(1)}s wall)${toCredits}${seek}`);
      log('pos', { uuid, pos, deltaPosMs: jump, wallMs: wall, state: s.st });
      s.pos = pos; s.posAt = t;
    }
  }
  for (const [uuid, s] of state) {
    if (!seen.has(uuid) && s.st !== 'gone') {
      console.log(`${clock()} SESSION ENDED on ${s.player} (${s.title})`);
      log('ended', { uuid, title: s.title });
      s.st = 'gone';
    }
  }
}

function parseMultipartPayload(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) {
    try { return JSON.parse(buf.toString('utf8')); } catch { return null; }
  }
  const boundary = Buffer.from(`--${m[1] || m[2]}`);
  let start = buf.indexOf(boundary);
  while (start !== -1) {
    const next = buf.indexOf(boundary, start + boundary.length);
    if (next === -1) break;
    const part = buf.subarray(start + boundary.length, next);
    const sep = part.indexOf('\r\n\r\n');
    if (sep !== -1) {
      const headers = part.subarray(0, sep).toString('utf8');
      if (/name="payload"/i.test(headers)) {
        const body = part.subarray(sep + 4).toString('utf8').replace(/\r\n$/, '');
        try { return JSON.parse(body); } catch { return null; }
      }
    }
    start = next;
  }
  return null;
}

function startWebhookListener() {
  if (!PORT) return;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const t = now();
      res.writeHead(200).end('ok');
      const payload = parseMultipartPayload(Buffer.concat(chunks), req.headers['content-type']);
      if (!payload) { console.log(`${clock()} HOOK (unparseable body from ${req.socket.remoteAddress})`); return; }
      const p = payload.Player ?? {};
      const md = payload.Metadata ?? {};
      hookCounts[payload.event] = (hookCounts[payload.event] ?? 0) + 1;
      if (p.uuid) hooks.set(p.uuid, { event: payload.event, t });
      if (!matchesPlayer(p.title, p.uuid) && p.uuid) return;
      const title = md.grandparentTitle ? `${md.grandparentTitle} - ${md.title}` : md.title;
      const vo = md.viewOffset !== undefined ? ` viewOffset=${hms(num(md.viewOffset))}` : ' viewOffset=(not in payload)';
      console.log(`${clock()} HOOK ${payload.event.padEnd(20)} player=${p.title ?? '-'} [${p.uuid ?? '-'}] user=${payload.Account?.title ?? '-'} lib=${md.librarySectionTitle ?? '-'} type=${md.type ?? '-'} "${title ?? ''}"${vo} local=${p.local}`);
      log('webhook', {
        event: payload.event, user: payload.Account?.title, owner: payload.owner, playerTitle: p.title, playerUuid: p.uuid,
        playerLocal: p.local, server: payload.Server?.title, library: md.librarySectionTitle, librarySectionType: md.librarySectionType,
        mediaType: md.type, title, ratingKey: md.ratingKey, viewOffset: num(md.viewOffset), duration: num(md.duration),
        metadataKeys: Object.keys(md), payloadKeys: Object.keys(payload),
      });
    });
  });
  server.on('error', (e) => console.log(`Webhook listener error: ${e.message}`));
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Webhook listener on port ${PORT}. In Plex: Settings > Webhooks > Add: http://<this-host-LAN-IP>:${PORT}/`);
  });
}

// Plex server push notifications (websocket). Event-driven, no polling, works without Plex Pass.
const wsCounts = {};
function startNotificationListener() {
  if (typeof WebSocket === 'undefined') {
    console.log('WebSocket not available in this Node version; skipping server notifications (needs Node 22+).');
    return;
  }
  const url = `${BASE.replace(/^http/, 'ws')}/:/websockets/notifications?X-Plex-Token=${encodeURIComponent(TOKEN)}`;
  let ws;
  const connect = () => {
    ws = new WebSocket(url);
    ws.onopen = () => console.log(`${clock()} WS connected to server notifications`);
    ws.onclose = () => { console.log(`${clock()} WS closed, reconnecting in 5 s`); setTimeout(connect, 5000); };
    ws.onerror = () => { /* onclose follows */ };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
      const c = msg.NotificationContainer ?? {};
      const type = c.type ?? 'unknown';
      const first = !wsCounts[type];
      wsCounts[type] = (wsCounts[type] ?? 0) + 1;
      if (type === 'playing') {
        for (const n of c.PlaySessionStateNotification ?? []) {
          const known = state.get(n.clientIdentifier);
          if (PLAYER && (n.clientIdentifier || '').toLowerCase() !== PLAYER && (known?.player || '').toLowerCase() !== PLAYER) continue;
          console.log(`${clock()} WS playing state=${n.state} pos=${hms(num(n.viewOffset))} ratingKey=${n.ratingKey} client=${n.clientIdentifier} session=${n.sessionKey}`);
          log('ws.playing', { state: n.state, pos: num(n.viewOffset), ratingKey: n.ratingKey, client: n.clientIdentifier, sessionKey: n.sessionKey, keys: Object.keys(n) });
        }
      } else if (first) {
        console.log(`${clock()} WS first "${type}" notification: ${JSON.stringify(c).slice(0, 240)}`);
        log('ws.other', { notificationType: type, sample: JSON.stringify(c).slice(0, 2000) });
      }
    };
  };
  connect();
}

function summary() {
  console.log('\n===== SUMMARY =====');
  for (const [uuid, s] of state) {
    const iv = [...s.intervals].sort((a, b) => a - b);
    const pct = (q) => (iv.length ? (iv[Math.min(iv.length - 1, Math.floor(q * iv.length))] / 1000).toFixed(1) + 's' : 'n/a');
    console.log(`${s.player} [${uuid}]: ${s.updates} position updates while tracked; interval between updates while playing: median ${pct(0.5)}, p90 ${pct(0.9)}, max ${pct(0.999)} (n=${iv.length})`);
  }
  console.log('Webhook events received:', Object.keys(hookCounts).length ? hookCounts : '(none)');
  console.log('Server notification types received (websocket):', Object.keys(wsCounts).length ? wsCounts : '(none)');
  console.log(`Full log: ${LOG}`);
}

// main
if (cmd === 'players') {
  await listPlayers();
} else if (cmd === 'prefs') {
  await showPrefs();
} else {
  console.log(`Watching ${BASE} every ${INTERVAL} ms${PLAYER ? ` for player "${PLAYER}"` : ''}. Ctrl-C for summary.`);
  console.log(`Logging to ${LOG}`);
  startWebhookListener();
  if (!argv.includes('--no-ws')) startNotificationListener();
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await pollOnce(); } finally { busy = false; }
  }, INTERVAL);
  process.on('SIGINT', () => { summary(); process.exit(0); });
  process.on('SIGTERM', () => { summary(); process.exit(0); });
}
