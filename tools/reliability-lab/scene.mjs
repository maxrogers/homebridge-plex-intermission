/* eslint-disable no-unused-vars -- shares its setup with lab.mjs */
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
    commands: { enabled: true, list: [{ id: 'log', name: 'Log', command: `echo {sensor} {state} {title} >> ${new URL('./commands.log', import.meta.url).pathname}` }] },
    sensors: [
      { id: 's-play', name: 'Media Playing', type: 'occupancy', state: 'playing', except: ['credits'], filters },
      { id: 's-pause', name: 'Media Paused', type: 'occupancy', state: 'paused', except: ['credits'], filters },
      { id: 's-credits', name: 'Credits Rolling', type: 'occupancy', state: 'credits', filters, run: { on: ['log'], off: ['log'] } },
      { id: 's-intro', name: 'Intro Playing', type: 'occupancy', state: 'intro', filters, run: { on: ['log'], off: ['log'] } },
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

// ---- mid-credits scene ----
plex.addItem({ ratingKey: '103', title: 'Scene Movie', type: 'movie', durationMs: 200_000, markers: [
  { type: 'intro', startTimeOffset: 31_000, endTimeOffset: 36_000, final: false },
  { type: 'credits', startTimeOffset: 40_000, endTimeOffset: 60_000, final: false },
  { type: 'credits', startTimeOffset: 80_000, endTimeOffset: 200_000, final: true },
] });
const four = ['Media Playing', 'Media Paused', 'Credits Rolling', 'Nothing Playing', 'Intro Playing'];
const snap = (label) => { const on = four.filter((n) => hub.values.get(hub.byName.get(n).key)).join('+') || '(none)'; say(`${label.padEnd(34)} -> ${on}`); checks.push({ label, on }); };
phase('scene movie');
plex.play('103', 30_000); await sleep(4_000); snap('~34 s, intro'); await sleep(3_000); snap('~37 s, playing');
await sleep(7_000); snap('44 s, first credits');
plex.pause(); await sleep(5_000); snap('paused in the credits');
plex.resume(); await sleep(2_000); snap('resumed in the credits');
await sleep(16_000); snap('~60 s, mid-credits scene');
plex.pause(); await sleep(5_000); snap('paused in the scene');
plex.resume(); await sleep(15_000); snap('~78 s, still the scene');
await sleep(5_000); snap('~83 s, final credits');
plex.stop(); await sleep(12_000); snap('stopped');
phases.push({ name: 'end', at: Date.now(), commands: rigs.map((r) => r.light.commands.length) });
// ---- report ----
await hub.disconnect();
await stopHomebridge();
await plex.close();

await writeFile(new URL(`./homebridge-${process.argv[2] ?? 'scene'}.log`, import.meta.url), stripVTControlCharacters(hbLog));
process.exit(0);
