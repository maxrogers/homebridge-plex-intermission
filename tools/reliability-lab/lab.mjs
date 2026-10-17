// Runs Intermission in a real Homebridge against a fake Plex server, with a real HAP controller as the
// home hub, and compares light rigs automated with buttons, with sensors, and with the current preset.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import { Hub, Rig } from './hub.mjs';
import { MockPlex } from './plex-mock.mjs';

const PLUGIN = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const PLEX_PORT = 32499;
const WEBHOOK_PORT = 32560;
const BRIDGE_PORT = 51839;
const SECRET = '0123456789abcdef0123456789abcdef';
const USERNAME = '0E:AA:BB:CC:DD:01';
const PIN = '031-45-154';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
const say = (...a) => console.log(stamp(), ...a);

const storage = await mkdtemp(join(tmpdir(), 'intermission-lab-'));
await mkdir(join(storage, 'intermission'), { recursive: true });
await writeFile(join(storage, 'intermission', 'credentials.json'), JSON.stringify({ accountToken: 'lab', username: 'Steve', savedAt: 'now', setupId: 'lab' }));
await writeFile(join(storage, 'intermission', 'state.json'), JSON.stringify({ clientIdentifier: 'lab-client', webhookSecret: SECRET }));
const filters = { players: ['APPLE-TV'] };
await writeFile(join(storage, 'config.json'), JSON.stringify({
  bridge: { name: 'Lab', username: USERNAME, port: BRIDGE_PORT, pin: PIN },
  platforms: [{
    platform: 'PlexIntermission', name: 'Intermission', setupId: 'lab', detailedLogging: true,
    servers: [{ id: 'mock-server', name: 'Mock', url: `http://127.0.0.1:${PLEX_PORT}` }],
    webhook: { enabled: true, port: WEBHOOK_PORT },
    sensors: [
      { id: 's-play', name: 'Media Playing', type: 'occupancy', state: 'playing', filters },
      { id: 's-pause', name: 'Media Paused', type: 'occupancy', state: 'paused', filters },
      { id: 's-credits', name: 'Credits Rolling', type: 'occupancy', state: 'credits', filters },
      { id: 's-idle', name: 'Nothing Playing', type: 'occupancy', state: 'idle', filters },
      { id: 'b-start', name: 'Started Button', type: 'button', events: ['play', 'resume'], filters },
      { id: 'b-pause', name: 'Paused Button', type: 'button', events: ['pause'], filters },
      { id: 'b-credits', name: 'Credits Button', type: 'button', events: ['credits.start'], filters },
      { id: 'b-stop', name: 'Stopped Button', type: 'button', events: ['stop'], filters },
    ],
  }],
}));

// ---- Homebridge ----
let child;
let hbLog = '';
async function startHomebridge() {
  child = spawn(join(PLUGIN, 'node_modules/.bin/homebridge'), ['-U', storage, '-P', PLUGIN, '--no-qrcode'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const mark = hbLog.length;
  child.stdout.on('data', (d) => { hbLog += d; });
  child.stderr.on('data', (d) => { hbLog += d; });
  const deadline = Date.now() + 40_000;
  while (!/is running on port/.test(stripVTControlCharacters(hbLog.slice(mark)))) {
    if (Date.now() > deadline) throw new Error(`Homebridge did not start:\n${hbLog.slice(mark)}`);
    await sleep(100);
  }
}
async function stopHomebridge() {
  const done = new Promise((r) => child.on('exit', r));
  child.kill('SIGTERM');
  await done;
}

// ---- Plex ----
const plex = new MockPlex({ port: PLEX_PORT, webhookUrl: `http://127.0.0.1:${WEBHOOK_PORT}/${SECRET}`, playStartLagMs: 3000 });
plex.addItem({ ratingKey: '101', title: 'Lab Movie', type: 'movie', durationMs: 120_000, markers: [{ type: 'credits', startTimeOffset: 80_000, endTimeOffset: 120_000, final: true }] });
plex.addItem({ ratingKey: '102', title: 'Lab Episode', type: 'episode', durationMs: 90_000, markers: [{ type: 'credits', startTimeOffset: 70_000, endTimeOffset: 90_000, final: true }] });
await plex.start();
await startHomebridge();
say('Homebridge running');

// ---- Hub and rigs ----
const hub = new Hub({ deviceId: USERNAME, port: BRIDGE_PORT, pin: PIN });
await hub.pair();
await hub.connect();
say('hub paired and subscribed:', [...hub.byName.keys()].join(', '));

const fade = { to: 100, steps: 10, everyMs: 2000 };
const rigs = [
  new Rig('A. Buttons only', hub, [
    { on: 'press', name: 'Started Button', set: 10 },
    { on: 'press', name: 'Paused Button', set: 60 },
    { on: 'press', name: 'Credits Button', ramp: { ...fade } },
    { on: 'press', name: 'Stopped Button', set: 100 },
  ]),
  new Rig('B. Sensors only', hub, [
    { on: 'detect', name: 'Media Playing', set: 10 },
    { on: 'detect', name: 'Media Paused', set: 60 },
    { on: 'detect', name: 'Credits Rolling', ramp: { ...fade, cancelIf: 'Media Playing' } },
    { on: 'detect', name: 'Nothing Playing', set: 100 },
  ]),
  new Rig('B2. Sensors only, hub ignores changes seen on reconnect', hub, [
    { on: 'detect', name: 'Media Playing', set: 10 },
    { on: 'detect', name: 'Media Paused', set: 60 },
    { on: 'detect', name: 'Credits Rolling', ramp: { ...fade, cancelIf: 'Media Playing' } },
    { on: 'detect', name: 'Nothing Playing', set: 100 },
  ], { reactToReconnect: false }),
  new Rig('C. Current preset (1 sensor + 3 buttons)', hub, [
    { on: 'detect', name: 'Media Playing', set: 10 },
    { on: 'press', name: 'Paused Button', set: 60 },
    { on: 'press', name: 'Credits Button', ramp: { ...fade, cancelIf: 'Media Playing' } },
    { on: 'press', name: 'Stopped Button', set: 100 },
  ]),
];

// ---- checks ----
const CREDITS = { 101: 80_000, 102: 70_000 };
function expected() {
  const s = plex.session;
  if (!s) return 100;
  if (s.state === 'paused') return 60;
  return plex.position() >= CREDITS[s.item.ratingKey] ? 100 : 10;
}
const checks = [];
function check(label) {
  const want = expected();
  const row = { at: stamp(), label, want, got: Object.fromEntries(rigs.map((r) => [r.name, r.light.level])) };
  checks.push(row);
  say(`CHECK ${label}: want ${want} | ${rigs.map((r) => `${r.name.split('.')[0]}=${r.light.level}${r.light.level === want ? '' : ' ✗'}`).join(' ')}`);
}
const phases = [];
function phase(name) {
  phases.push({ name, at: Date.now(), commands: rigs.map((r) => r.light.commands.length) });
  say(`--- ${name}`);
}

async function reconnectHub() {
  for (let i = 0; i < 50; i++) {
    try {
      await hub.connect();
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error('hub could not reconnect');
}

// ---- scenario ----
phase('1. Play a movie');
plex.play('101', 0);
await sleep(14_000); check('playing');

phase('2. Blip pause (1 s)');
plex.pause(); await sleep(1000); plex.resume(); await sleep(6000); check('still playing after a blip');

phase('3. Real pause, then resume');
plex.pause(); await sleep(6000); check('paused');
plex.resume(); await sleep(5000); check('resumed');

phase('4. Fiddling: 6 quick pause/resume pairs and two skips');
for (let i = 0; i < 6; i++) { plex.pause(); await sleep(600); plex.resume(); await sleep(800); }
plex.seek(plex.position() + 20_000); await sleep(700); plex.seek(plex.position() - 10_000);
await sleep(6000); check('playing after fiddling');

phase('5. Hub offline while pausing');
await hub.disconnect(); plex.pause(); await sleep(6000);
await reconnectHub(); await sleep(2000); check('paused, hub back');
plex.resume(); await sleep(5000); check('resumed');

phase('6. Credits');
plex.seek(74_000); await sleep(6000 + 1000); await sleep(22_000); check('credits fade done');

phase('7. Rewind out of the credits and keep watching');
plex.seek(15_000); await sleep(6000); check('playing again after rewind');

phase('8. Hub offline when the credits start');
await hub.disconnect(); plex.seek(77_000); await sleep(6000);
await reconnectHub(); await sleep(24_000); check('credits, hub back');

phase('9. Stop');
plex.stop(); await sleep(13_000); check('stopped');

phase('10. Homebridge restarts while paused, playback resumes while it is down');
plex.play('101', 30_000); await sleep(14_000); check('playing');
plex.pause(); await sleep(5000); check('paused');
await hub.disconnect();
await stopHomebridge(); say('Homebridge stopped');
plex.resume();
await startHomebridge(); say('Homebridge back');
await reconnectHub(); await sleep(12_000); check('playing after restart');

phase('10b. Homebridge restarts mid-movie and Plex is slow to answer');
await hub.disconnect();
await stopHomebridge();
plex.sessionsDelayMs = 6000;
await startHomebridge();
await reconnectHub(); say('hub back before Plex answered');
await sleep(2000); check('playing while Plex is slow');
await sleep(8000); plex.sessionsDelayMs = 0; check('playing after Plex answered');

phase('11. Autoplay the next episode');
plex.seek(76_000); await sleep(7000);
plex.stop(); await sleep(3000); plex.play('102', 0);
await sleep(15_000); check('next episode playing');

phase('12. Websocket drops while paused (Plex blip)');
plex.dropSockets(); plex.pause(); await sleep(8000); check('paused while plugin reconnects');
plex.resume(); await sleep(6000); check('resumed');

phase('13. Stop for the night');
plex.stop(); await sleep(13_000); check('stopped');
phases.push({ name: 'end', at: Date.now(), commands: rigs.map((r) => r.light.commands.length) });

// ---- report ----
await hub.disconnect();
await stopHomebridge();
await plex.close();

const results = {
  label: process.argv[2] ?? 'run',
  rigs: rigs.map((r, i) => ({
    name: r.name,
    correct: checks.filter((c) => c.got[r.name] === c.want).length,
    total: checks.length,
    commands: r.light.commands.length,
    perPhase: phases.slice(0, -1).map((p, j) => ({ phase: p.name, commands: phases[j + 1].commands[i] - p.commands[i] })),
    log: r.light.commands.map((c) => ({ at: ((c.at - t0) / 1000).toFixed(1), from: c.from, to: c.to, why: c.why })),
  })),
  checks,
  hubEvents: hub.events.map((e) => ({ at: ((e.at - t0) / 1000).toFixed(1), ...e })),
  plexLog: plex.log.map((e) => ({ ...e, at: ((e.at - t0) / 1000).toFixed(1) })),
};
await writeFile(new URL(`./results-${process.argv[2] ?? 'run'}.json`, import.meta.url), JSON.stringify(results, null, 2));
await writeFile(new URL(`./homebridge-${process.argv[2] ?? 'run'}.log`, import.meta.url), stripVTControlCharacters(hbLog));
for (const r of results.rigs) say(`${r.name}: ${r.correct}/${r.total} checks right, ${r.commands} light commands`);
process.exit(0);
