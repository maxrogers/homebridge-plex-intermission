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

const fade = { to: 100, steps: 5, everyMs: 1000 };
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

// ---- randomised run ----
let seed = Number(process.env.SEED ?? 7);
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const between = (a, b) => a + rand() * (b - a);
const samples = rigs.map(() => ({ right: 0, total: 0 }));
const sampler = setInterval(() => {
  const want = expected();
  rigs.forEach((r, i) => { samples[i].total++; if (r.light.level === want) samples[i].right++; });
}, 500);
phase('fuzz');
plex.play('101', 0); await sleep(12_000);
const ROUNDS = Number(process.env.ROUNDS ?? 40);
for (let round = 1; round <= ROUNDS; round++) {
  const outage = rand() < 0.25;
  if (outage) await hub.disconnect();
  const roll = rand();
  let action;
  if (!plex.session) { action = 'play'; plex.play(rand() < 0.5 ? '101' : '102', between(0, 50_000)); }
  else if (roll < 0.25) { action = 'blip pause'; plex.pause(); await sleep(between(300, 1500)); plex.resume(); }
  else if (roll < 0.45) { action = 'pause'; plex.pause(); await sleep(between(3000, 9000)); if (rand() < 0.7) { plex.resume(); action += '+resume'; } }
  else if (roll < 0.6) { action = 'skip'; plex.seek(Math.max(0, plex.position() + between(-30_000, 30_000))); }
  else if (roll < 0.72) { action = 'to credits'; plex.seek(CREDITS[plex.session.item.ratingKey] - between(1000, 4000)); await sleep(5000); }
  else if (roll < 0.82) { action = 'rewind out of credits'; plex.seek(between(0, 10_000)); }
  else if (roll < 0.92) { action = 'autoplay'; plex.stop(); await sleep(between(1000, 4000)); plex.play(rand() < 0.5 ? '101' : '102', 0); }
  else { action = 'stop'; plex.stop(); }
  if (outage) { await sleep(between(2000, 6000)); await reconnectHub(); }
  await sleep(15_000);
  check(`round ${round}: ${action}${outage ? ' (hub offline)' : ''}`);
}
clearInterval(sampler);
phases.push({ name: 'end', at: Date.now(), commands: rigs.map((r) => r.light.commands.length) });
// ---- report ----
await hub.disconnect();
await stopHomebridge();
await plex.close();

const results = {
  samples: rigs.map((r, i) => ({ name: r.name, ...samples[i] })),
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
for (const x of results.samples) say(`${x.name}: right ${(100 * x.right / x.total).toFixed(1)}% of the time`);
process.exit(0);
