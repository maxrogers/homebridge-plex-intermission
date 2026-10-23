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
  assert.match(c._bridge.username, /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/, 'own child bridge by default');
  assert.ok(c._bridge.port >= 51000 && c._bridge.port < 57000 && c._bridge.port !== 51826);
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
  assert.ok(await page.$('[data-action=toggle-presets]'), 'Add preset is offered');
});

await flow('Live TV is listed per server but not preselected', async () => {
  const { page } = await open({ s: 'server', servers: 'srv' });
  await click(page, '[data-action=webhooks-next]');
  await page.waitForTimeout(300);
  assert.ok(await page.$('[data-action=toggle-library][data-id="srv/livetv"]'));
  assert.ok(!(await selectedLibraries(page)).includes('srv/livetv'));
});

await flow('Add preset on an empty board adds it at once', async () => {
  const { page } = await open({ s: 'main', existing: JSON.stringify({ platform: 'PlexIntermission', setupId: 'x', servers: [{ id: 'srv', name: 'Unraid', url: 'http://srv' }], sensors: [],
    selection: { players: [], allPlayers: true, allUsers: true, users: [], allLibraries: true, libraries: [] } }) });
  await click(page, '[data-action=toggle-presets]');
  await click(page, '[data-action=pick-preset][data-id=states]');
  const c = await config(page);
  assert.deepEqual(c.sensors.map((x) => x.name), ['Media Playing', 'Media Paused', 'Credits Rolling', 'Nothing Playing']);
  assert.equal(c.preset, 'states');
  assert.ok(await page.$('.im-group'), 'shown as a group');
  assert.equal(await page.$('.im-group .im-hint'), null, 'intact: no warning');
});

await flow('Add preset with sensors: alongside keeps them; replace needs two taps and keeps same-name sensors', async () => {
  const { page, errors } = await open({ s: 'main' });
  await click(page, '[data-action=toggle-presets]');
  await click(page, '[data-action=pick-preset][data-id=credits]');
  assert.ok(await page.$('#im-preset-choice'));
  await click(page, '[data-action=preset-alongside]');
  let c = await config(page);
  assert.equal(c.sensors.length, 6);
  assert.equal(c.sensors[5].name, 'Media Playing 2');

  await click(page, '[data-action=toggle-presets]');
  await click(page, '[data-action=pick-preset][data-id=states]');
  await click(page, '[data-action=preset-replace]');
  assert.equal((await config(page)).sensors.length, 6, 'first tap only asks');
  assert.match(await page.textContent('#im-preset-choice'), /Home automations that use them stop working/);
  await click(page, '[data-action=preset-replace]');
  c = await config(page);
  assert.equal(c.sensors.length, 4);
  assert.equal(c.sensors.find((x) => x.name === 'Media Playing').id, 's-1', 'same name keeps its identity');
  assert.deepEqual(errors, []);
});

await flow('Every State group: editing shows the warning; Remove set removes all four', async () => {
  const { page } = await open({ s: 'main' });
  assert.equal(await page.$('.im-group .im-hint'), null);
  await click(page, '[data-action=edit][data-id=s-3]');
  await click(page, '[data-action=toggle-except][data-id=credits]');
  assert.ok(await page.$('.im-group .im-hint'), 'warning after an edit');
  await click(page, '[data-action=remove-group]');
  await click(page, '[data-action=remove-group]');
  const c = await config(page);
  assert.deepEqual(c.sensors.map((x) => x.id), ['s-6']);
});

await flow('Guide: Add this preset leads to the choice on the Sensors tab', async () => {
  const { page } = await open({ s: 'main' });
  await click(page, '[data-action=tab][data-id=recipes]');
  assert.ok(await page.$('.im-callout [aria-expanded=true]'), 'Good to know starts open');
  const order = await page.$$eval('[data-preset]', (els) => els.map((el) => el.dataset.preset));
  assert.deepEqual(order, ['states'], 'only the preset in use shows; the others are folded');
  assert.equal(await page.$('[data-action=pick-preset][data-id=states]'), null, 'no "Add this preset" for one in use');
  await click(page, '[data-action=toggle-open][data-id=other-presets]');
  assert.deepEqual(await page.$$eval('[data-preset]', (els) => els.map((el) => el.dataset.preset)), ['states', 'simple', 'credits']);
  await click(page, '[data-action=pick-preset][data-id=simple]');
  assert.ok(await page.$('#im-preset-choice'));
  assert.ok(await page.$('[data-action=tab][data-id=sensors][aria-selected=true]'));
});

await flow('credits choice in the editor is shared and matches Settings', async () => {
  const { page } = await open({ s: 'main' });
  await click(page, '[data-action=edit][data-id=s-1]');
  assert.ok(await page.$('[data-action=set-credits-mode][data-id=scenes][aria-pressed=true]'));
  await click(page, '[data-action=set-credits-mode][data-id=final]');
  assert.equal((await config(page)).timing.midCredits, 'final');
  await click(page, '[data-action=edit][data-id=s-4]');
  assert.ok(await page.$('[data-action=set-credits-mode][data-id=final][aria-pressed=true]'), 'In the credits sensor shows the same choice');
  await click(page, '[data-action=tab][data-id=advanced]');
  assert.equal(await page.$eval('[data-credits-mode]', (el) => el.value), 'final');
  await click(page, '[data-action=tab][data-id=sensors]');
  await click(page, '[data-action=set-credits-mode][data-id=scenes]');
  assert.equal((await config(page)).timing.midCredits, undefined, 'default is not stored');
});

await flow('media conditions: chips, labels and + condition from Now playing', async () => {
  const { page, errors } = await open({ s: 'main' });
  await click(page, '[data-action=edit][data-id=s-6]');
  assert.ok(await page.$('[data-action=media-shape][data-id=wide][aria-pressed=true]'), 'opens with its conditions');
  await click(page, '[data-action=media-toggle][data-group=resolution][data-id="4k"]');
  await page.fill('[data-media-labels]', 'Date Night, Kids, Kids');
  await page.dispatchEvent('[data-media-labels]', 'change');
  await page.waitForTimeout(200);
  await click(page, '[data-action=now-playing]');
  await page.waitForTimeout(200);
  assert.match(await page.textContent('.im-nowplaying'), /Wide 2\.39:1/);
  assert.match(await page.textContent('.im-nowplaying'), /Live TV: Plex has no picture/);
  await click(page, '[data-action=media-add][data-group=ratings]');
  let c = (await config(page)).sensors.find((x) => x.id === 's-6');
  assert.deepEqual(c.media, { shape: 'wide', resolution: ['4k'], labels: ['Date Night', 'Kids'], ratings: ['PG-13'] });
  assert.match(await page.textContent('[data-index="4"] .im-summary'), /with a wide picture, 4K, rated PG-13/);
  await click(page, '[data-action=media-any][data-group=ratings]');
  await click(page, '[data-action=media-any][data-group=resolution]');
  await click(page, '[data-action=media-shape][data-id=wide]');
  await page.fill('[data-media-labels]', '');
  await page.dispatchEvent('[data-media-labels]', 'change');
  await page.waitForTimeout(200);
  c = (await config(page)).sensors.find((x) => x.id === 's-6');
  assert.equal(c.media, undefined, 'no conditions left: nothing stored');
  assert.deepEqual(errors, []);
});

await flow('banners: restart needed, unsaved changes; port amber while waiting and red when not listening', async () => {
  let { page } = await open({ s: 'main', runtime: 'stale', port: 'free' });
  assert.match(await page.textContent('.im-banner-info'), /Restart Homebridge to apply/);
  await click(page, '[data-action=tab][data-id=advanced]');
  assert.ok(await page.$('#im-webhooks .im-status.warn'), 'amber while a restart is due');
  await click(page, '[data-action=tab][data-id=sensors]');
  await click(page, '[data-action=edit][data-id=s-1]');
  await click(page, '[data-action=toggle-except][data-id=intro]');
  assert.match(await page.textContent('.im-banner-info'), /unsaved changes/);
  ({ page } = await open({ s: 'main', port: 'free' }));
  assert.equal(await page.$('.im-banner-info'), null, 'running the saved settings: no banner');
  await click(page, '[data-action=tab][data-id=advanced]');
  assert.match(await page.textContent('#im-webhooks'), /Not listening/);
  ({ page } = await open({ s: 'main', runtime: 'none' }));
  assert.match(await page.textContent('.im-banner-info'), /Restart Homebridge to start it/);
});

await flow('child bridge: can be turned off at setup; pairing card until added; not offered once set up', async () => {
  let { page } = await open({ s: 'server', servers: 'srv' });
  await click(page, '[data-action=webhooks-next]');
  await page.waitForTimeout(300);
  await click(page, '[data-action=to-template]');
  assert.ok(await page.$('[data-child-bridge]:checked'), 'on by default');
  await page.uncheck('[data-child-bridge]');
  await click(page, '[data-action=finish]');
  assert.equal((await config(page))._bridge, undefined);

  ({ page } = await open({ s: 'main' }));
  assert.match(await page.textContent('.im-pairing'), /031-45-154/);
  assert.ok(await page.$('.im-qr svg'));
  await click(page, '[data-action=tab][data-id=advanced]');
  assert.match(await page.textContent('.im-facts'), /Intermission's own bridge/);

  ({ page } = await open({ s: 'main', pairing: 'paired' }));
  assert.equal(await page.$('.im-pairing'), null, 'gone once paired');
  ({ page } = await open({ s: 'main', bridge: 'main' }));
  assert.equal(await page.$('.im-pairing'), null, 'main bridge: no card');
  await click(page, '[data-action=tab][data-id=advanced]');
  await click(page, '[data-action=redo-setup]');
  await page.waitForTimeout(400);
  await click(page, '[data-action=use-servers]');
  await click(page, '[data-action=webhooks-next]');
  await page.waitForTimeout(300);
  assert.equal(await page.$('[data-child-bridge]'), null, 'not offered when sensors exist');
});

console.log(results.join('\n'));
await browser.close();
