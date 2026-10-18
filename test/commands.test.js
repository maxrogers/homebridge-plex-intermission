import assert from 'node:assert/strict';
import test from 'node:test';

import { CommandRunner, expandCommand, shellQuote } from '../dist/commands.js';
import { parseConfig } from '../dist/config.js';
import { silentLog } from './helpers.js';

test('placeholders are quoted, so titles cannot change the command', () => {
  const title = `It's "Here"; rm -rf ~ $(whoami)`;
  assert.equal(expandCommand('say {title} on {player}', { title, player: 'Living Room' }, 'linux'),
    `say 'It'\\''s "Here"; rm -rf ~ $(whoami)' on 'Living Room'`);
  assert.equal(expandCommand('echo {unknown} {library}', {}, 'linux'), `echo {unknown} ''`);
  assert.equal(shellQuote('100%"x"', 'win32'), '"100%%""x"""');
});

test('commands run with the playing item, report output and exit codes, and time out', async () => {
  const runner = new CommandRunner(silentLog, 1000);
  const ok = await runner.run({ id: 'a', name: 'Echo', command: 'printf %s {title}' }, { title: `Bob's "movie"; echo hacked` });
  assert.deepEqual(ok, { code: 0, output: `Bob's "movie"; echo hacked`, timedOut: false });
  const failed = await runner.run({ id: 'b', name: 'Fail', command: 'echo nope >&2; exit 3' }, {});
  assert.equal(failed.code, 3);
  assert.equal(failed.output, 'nope');
  const slow = await runner.run({ id: 'c', name: 'Slow', command: 'sleep 5' }, {});
  assert.equal(slow.timedOut, true);
});

test('commands are off unless enabled; sensors keep their command choices', () => {
  const sensors = [{ id: 's', name: 'Playing', type: 'occupancy', state: 'playing', run: { on: ['dim'], off: ['up'] } }];
  const off = parseConfig({ commands: { enabled: false, list: [{ id: 'dim', name: 'Dim', command: 'true' }] }, sensors }, silentLog);
  assert.deepEqual(off.commands, []);
  const on = parseConfig({ commands: { enabled: true, list: [{ id: 'dim', name: 'Dim', command: 'true' }, { id: 'bad', name: '', command: 'x' }] }, sensors }, silentLog);
  assert.deepEqual(on.commands.map((c) => c.id), ['dim']);
  assert.deepEqual(on.sensors[0].run, { on: ['dim'], off: ['up'], press: [] });
});
