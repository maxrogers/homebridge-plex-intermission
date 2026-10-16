import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import plugin from '../dist/index.js';

const schema = JSON.parse(await readFile(new URL('../config.schema.json', import.meta.url), 'utf8'));

test('registers the platform under the config schema alias', () => {
  const registered = [];
  plugin({ registerPlatform: (name) => registered.push(name) });
  assert.deepEqual(registered, [schema.pluginAlias]);
});
