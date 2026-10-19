// Real Homebridge with Intermission on a child bridge made by the settings page's newChildBridge():
// does Homebridge accept it, does the pairing code we read match, and does a hub pair and see the sensors?
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { Hub } from './hub.mjs';
import { MockPlex } from './plex-mock.mjs';

const PLUGIN = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const { newChildBridge } = await import(`${PLUGIN}/homebridge-ui/public/model.js`);
const { bridgePairing } = await import(`${PLUGIN}/dist/child-bridge.js`);
const { configFingerprint } = await import(`${PLUGIN}/dist/runtime.js`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PIN = '031-45-154';
const storage = await mkdtemp(join(tmpdir(), 'intermission-cb-'));
await mkdir(join(storage, 'intermission'), { recursive: true });
await writeFile(join(storage, 'intermission', 'credentials.json'), JSON.stringify({ accountToken: 'lab', username: 'Steve', savedAt: 'now', setupId: 'lab' }));
await writeFile(join(storage, 'intermission', 'state.json'), JSON.stringify({ clientIdentifier: 'lab-client', webhookSecret: '0123456789abcdef0123456789abcdef' }));
const bridge = newChildBridge();
console.log('child bridge config', bridge);
const platform = {
  platform: 'PlexIntermission', name: 'Intermission', setupId: 'lab', _bridge: bridge,
  servers: [{ id: 'mock-server', name: 'Mock', url: 'http://127.0.0.1:32499' }],
  webhook: { enabled: false },
  sensors: [{ id: 's-play', name: 'Media Playing', type: 'occupancy', state: 'playing' }, { id: 's-idle', name: 'Nothing Playing', type: 'occupancy', state: 'idle' }],
};
await writeFile(join(storage, 'config.json'), JSON.stringify({ bridge: { name: 'Lab', username: '0E:AA:BB:CC:DD:02', port: 51840, pin: PIN }, platforms: [platform] }));
const plex = new MockPlex({ port: 32499, webhookUrl: 'http://127.0.0.1:1/x', playStartLagMs: 0 });
await plex.start();
let log = '';
const child = spawn(join(PLUGIN, 'node_modules/.bin/homebridge'), ['-U', storage, '-P', PLUGIN, '--no-qrcode'], { stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });
const deadline = Date.now() + 60_000;
while ((stripVTControlCharacters(log).match(/is running on port/g) ?? []).length < 2) {
  if (Date.now() > deadline) { console.log(stripVTControlCharacters(log)); throw new Error('child bridge did not start'); }
  await sleep(200);
}
await sleep(1500);
const before = await bridgePairing(storage, bridge.username);
console.log('pairing before', { ...before, setupURI: before.setupURI?.slice(0, 9) + '…' });
const running = JSON.parse(await readFile(join(storage, 'intermission', 'running.json'), 'utf8'));
console.log('running fingerprint matches saved config:', running.fingerprint === configFingerprint(platform));
const hub = new Hub({ deviceId: bridge.username, port: bridge.port, pin: before.pincode });
await hub.pair();
await hub.connect();
console.log('sensors on the child bridge:', [...hub.byName.keys()].join(', '));
const after = await bridgePairing(storage, bridge.username);
console.log('paired after hub pairing:', after.paired);
const text = stripVTControlCharacters(log);
console.log('log lines:', text.split('\n').filter((l) => /child bridge|Intermission\]|running on port|Setup Code|error/i.test(l)).slice(0, 14).join('\n'));
await hub.http?.close?.();
child.kill('SIGTERM');
await plex.close();
process.exit(0);
