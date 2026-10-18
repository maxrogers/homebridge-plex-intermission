/* global window -- runs inside the page */
// Clicks through the setup flows in the real settings page (mocked Homebridge and Plex) and checks the saved config.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}) });
const results = [];

async function open(query) {
  const page = await browser.newPage({ viewport: { width: 900, height: 1200 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:8765/?${new URLSearchParams(query)}`);
  await page.waitForTimeout(500);
  return { page, errors };
}
const click = async (page, selector) => { await page.click(selector); await page.waitForTimeout(250); };
const config = (page) => page.evaluate(() => window.__config());
const selectedLibraries = (page) => page.$$eval('[data-action=toggle-library][aria-pressed=true]', (els) => els.map((e) => e.dataset.id));
const libs = (sensor) => sensor.filters.libraries;

async function flow(name, fn) {
  try {
    await fn();
    results.push(`PASS ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}: ${error.message.split('\n').slice(0, 6).join(' ')}`);
  }
}

const existing = (serverIds, libraries) => JSON.stringify({
  platform: 'PlexIntermission', name: 'Intermission', setupId: 'x',
  servers: serverIds.map((id) => ({ id, name: id === 'srv' ? 'Unraid' : 'Cabin', url: `http://${id}` })),
  selection: { players: [{ id: 'ATV', name: 'Living Room' }], allUsers: true, users: [], allPlayers: false, allLibraries: false,
    libraries: libraries.map((key) => ({ key, title: key, kind: key.endsWith('/2') ? 'show' : 'movie', serverId: key.split('/')[0], serverName: key.split('/')[0] })) },
  sensors: ['playing', 'paused', 'credits', 'idle'].map((state) => ({ id: state, name: state, type: 'occupancy', state, filters: { players: ['ATV'], users: [], libraries: [...libraries], mediaTypes: [] } })),
});

await flow('one server: chosen automatically, Movies and TV preselected, preset saved', async () => {
  const { page, errors } = await open({ s: 'server', servers: 'srv' });
  assert.equal(await page.$('[data-action=webhooks-next]') !== null, true, 'went straight to the webhook step');
  await click(page, '[data-action=webhooks-next]');
  await page.waitForTimeout(300);
  assert.deepEqual(await selectedLibraries(page), ['srv/1', 'srv/2']);
  assert.equal(await page.$('.im-subhead'), null, 'no per-server headings with one server');
  await click(page, '[data-action=to-template]');
  await click(page, '[data-action=finish]');
  const c = await config(page);
  assert.deepEqual(c.servers.map((s) => s.id), ['srv']);
  assert.equal(c.sensors.length, 1);
  assert.deepEqual(libs(c.sensors[0]), ['srv/1', 'srv/2']);
  assert.deepEqual(errors, []);
});

await flow('two owned servers: both chosen, Movies and TV on both, grouped by server; shared server not chosen', async () => {
  const { page } = await open({ s: 'server', servers: 'srv,cab,mom' });
  const chosen = await page.$$eval('[data-action=toggle-server][aria-pressed=true]', (els) => els.map((e) => e.dataset.id));
  assert.deepEqual(chosen, ['srv', 'cab']);
  await click(page, '[data-action=use-servers]');
  await click(page, '[data-action=webhooks-next]');
  await page.waitForTimeout(300);
  assert.deepEqual(await selectedLibraries(page), ['srv/1', 'srv/2', 'cab/1']);
  assert.equal((await page.$$('.im-subhead')).length, 2);
  await click(page, '[data-action=to-template]');
  await click(page, '[data-action=pick-template][data-id=states]');
  await click(page, '[data-action=finish]');
  const c = await config(page);
  assert.deepEqual(c.servers.map((s) => s.id), ['srv', 'cab']);
  assert.equal(c.sensors.length, 4);
  assert.ok(c.sensors.every((s) => libs(s).join() === 'srv/1,srv/2,cab/1'));
});

await flow('unchoosing a server before continuing leaves its libraries out', async () => {
  const { page } = await open({ s: 'server', servers: 'srv,cab' });
  await click(page, '[data-action=toggle-server][data-id=cab]');
  await click(page, '[data-action=use-servers]');
  await click(page, '[data-action=webhooks-next]');
  await page.waitForTimeout(300);
  assert.deepEqual(await selectedLibraries(page), ['srv/1', 'srv/2']);
  await click(page, '[data-action=to-template]');
  await click(page, '[data-action=finish]');
  assert.deepEqual(libs((await config(page)).sensors[0]), ['srv/1', 'srv/2']);
});

await flow('a shared server can be added; its movie library is chosen too', async () => {
  const { page } = await open({ s: 'server', servers: 'srv,mom' });
  await click(page, '[data-action=toggle-server][data-id=mom]');
  await click(page, '[data-action=use-servers]');
  await click(page, '[data-action=webhooks-next]');
  await page.waitForTimeout(300);
  assert.deepEqual(await selectedLibraries(page), ['srv/1', 'srv/2', 'mom/1']);
});

await flow('no server chosen: Next is disabled', async () => {
  const { page } = await open({ s: 'server', servers: 'srv,cab' });
  await click(page, '[data-action=toggle-server][data-id=srv]');
  await click(page, '[data-action=toggle-server][data-id=cab]');
  assert.equal(await page.$eval('[data-action=use-servers]', (b) => b.disabled), true);
});

await flow('later: removing a server updates choices and every sensor', async () => {
  const { page } = await open({ s: 'main', servers: 'srv,cab', existing: existing(['srv', 'cab'], ['srv/1', 'srv/2', 'cab/1']) });
  await click(page, '[data-action=tab][data-id=advanced]');
  await click(page, '[data-action=redo-setup]');
  await page.waitForTimeout(300);
  const chosen = await page.$$eval('[data-action=toggle-server][aria-pressed=true]', (els) => els.map((e) => e.dataset.id));
  assert.deepEqual(chosen, ['srv', 'cab'], 'starts from the saved servers');
  await click(page, '[data-action=toggle-server][data-id=cab]');
  await click(page, '[data-action=use-servers]');
  await click(page, '[data-action=webhooks-next]');
  await page.waitForTimeout(300);
  assert.deepEqual(await selectedLibraries(page), ['srv/1', 'srv/2']);
  await click(page, '[data-action=to-template]');
  const c = await config(page);
  assert.deepEqual(c.servers.map((s) => s.id), ['srv']);
  assert.ok(c.sensors.every((s) => libs(s).join() === 'srv/1,srv/2'), JSON.stringify(c.sensors.map(libs)));
  assert.equal(c.sensors.length, 4, 'sensors are kept');
});

await flow('later: adding a server adds its Movies and TV to choices and sensors', async () => {
  const { page } = await open({ s: 'main', servers: 'srv,cab', existing: existing(['srv'], ['srv/1', 'srv/2']) });
  await click(page, '[data-action=tab][data-id=advanced]');
  await click(page, '[data-action=redo-setup]');
  await page.waitForTimeout(300);
  await click(page, '[data-action=toggle-server][data-id=cab]');
  await click(page, '[data-action=use-servers]');
  await click(page, '[data-action=webhooks-next]');
  await page.waitForTimeout(300);
  assert.deepEqual(await selectedLibraries(page), ['srv/1', 'srv/2', 'cab/1']);
  await click(page, '[data-action=to-template]');
  const c = await config(page);
  assert.ok(c.sensors.every((s) => libs(s).join() === 'srv/1,srv/2,cab/1'), JSON.stringify(c.sensors.map(libs)));
});

await flow('later: cancelling changes nothing', async () => {
  const before = existing(['srv', 'cab'], ['srv/1', 'srv/2', 'cab/1']);
  const { page } = await open({ s: 'main', servers: 'srv,cab', existing: before });
  await click(page, '[data-action=tab][data-id=advanced]');
  await click(page, '[data-action=redo-setup]');
  await page.waitForTimeout(300);
  await click(page, '[data-action=toggle-server][data-id=cab]');
  await click(page, '[data-action=use-servers]');
  await click(page, '[data-action=cancel-setup]');
  const c = await config(page);
  assert.deepEqual(c.servers.map((s) => s.id), ['srv', 'cab']);
  assert.ok(c.sensors.every((s) => libs(s).join() === 'srv/1,srv/2,cab/1'));
  assert.ok(await page.$('[data-action=tab]'), 'back on the main page');
});

await flow('All libraries stays "all" through server changes', async () => {
  const { page } = await open({ s: 'server', servers: 'srv,cab' });
  await click(page, '[data-action=use-servers]');
  await click(page, '[data-action=webhooks-next]');
  await page.waitForTimeout(300);
  await click(page, '[data-action=libraries-all]');
  assert.deepEqual(await selectedLibraries(page), []);
  await click(page, '[data-action=to-template]');
  await click(page, '[data-action=finish]');
  assert.deepEqual(libs((await config(page)).sensors[0]), []);
});

await flow('Refresh keeps manual picks; Back from the last step keeps them too', async () => {
  const { page } = await open({ s: 'server', servers: 'srv' });
  await click(page, '[data-action=webhooks-next]');
  await page.waitForTimeout(300);
  await click(page, '[data-action=toggle-library][data-id="srv/2"]');
  await click(page, '[data-action=toggle-library][data-id="srv/3"]');
  await click(page, '[data-action=refresh-choose]');
  await page.waitForTimeout(300);
  assert.deepEqual(await selectedLibraries(page), ['srv/1', 'srv/3']);
  await click(page, '[data-action=to-template]');
  await click(page, '[data-action=back-choose]');
  assert.deepEqual(await selectedLibraries(page), ['srv/1', 'srv/3']);
});

await flow('specific people: Next waits until someone is ticked; the choice reaches the sensors', async () => {
  const { page } = await open({ s: 'server', servers: 'srv' });
  await click(page, '[data-action=webhooks-next]');
  await page.waitForTimeout(300);
  await click(page, '[data-action=users-some]');
  assert.equal(await page.$eval('[data-action=to-template]', (b) => b.disabled), true);
  await page.check('[data-user=Jen]');
  await page.waitForTimeout(200);
  await click(page, '[data-action=to-template]');
  await click(page, '[data-action=finish]');
  assert.deepEqual((await config(page)).sensors[0].filters.users, ['Jen']);
});

await flow('scratch: no sensors created, board shows the add buttons', async () => {
  const { page } = await open({ s: 'server', servers: 'srv' });
  await click(page, '[data-action=webhooks-next]');
  await page.waitForTimeout(300);
  await click(page, '[data-action=to-template]');
  await click(page, '[data-action=pick-template][data-id=scratch]');
  await click(page, '[data-action=finish]');
  assert.equal((await config(page)).sensors.length, 0);
  assert.ok(await page.$('[data-action=add-template][data-id=credits]'));
});

console.log(results.join('\n'));
await browser.close();
