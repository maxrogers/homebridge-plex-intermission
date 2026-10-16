// Starts a real Homebridge with this plugin, like the Homebridge verification checks do.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const homebridge = join(root, 'node_modules', '.bin', 'homebridge');

async function runHomebridge(platforms) {
  const storage = await mkdtemp(join(tmpdir(), 'intermission-'));
  const port = 52000 + Math.floor(Math.random() * 1000);
  const bridge = { name: 'Test', username: '0E:11:22:33:44:77', port, pin: '031-45-154' };
  await writeFile(join(storage, 'config.json'), JSON.stringify({ bridge, platforms }));

  const child = spawn(homebridge, ['-U', storage, '-P', root, '--no-qrcode'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((done) => child.on('exit', (code, signal) => done({ code, signal })));

  try {
    const deadline = Date.now() + 30_000;
    while (!/is running on port/.test(output)) {
      assert.ok(Date.now() < deadline, `Homebridge did not start:\n${output}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    const stopAt = Date.now();
    child.kill('SIGTERM');
    const result = await exited;
    return { output, result, shutdownMs: Date.now() - stopAt };
  } finally {
    child.kill('SIGKILL');
    await rm(storage, { recursive: true, force: true });
  }
}

test('does not start without configuration', async () => {
  const { output, shutdownMs } = await runHomebridge([]);
  assert.match(output, /Loaded plugin: homebridge-plex-intermission/);
  assert.doesNotMatch(output, /\[Intermission\]/);
  assert.ok(shutdownMs < 12_000, `shutdown took ${shutdownMs} ms`);
});

test('starts with only the platform configured and shuts down cleanly', async () => {
  const { output, shutdownMs } = await runHomebridge([{ platform: 'PlexIntermission', name: 'Intermission' }]);
  assert.match(output, /\[Intermission\] Not signed in to Plex yet/);
  assert.doesNotMatch(output, /unhandled|uncaught|TypeError|ReferenceError/i);
  assert.ok(shutdownMs < 12_000, `shutdown took ${shutdownMs} ms`);
});
