/* global window, document -- runs inside the page */
// Clicks through the setup flows in the real settings page (mocked Homebridge and Plex) and checks the saved config.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}) });
const results = [];

/** Pages opened by the current flow, closed and checked for errors when it ends. */
let opened = [];

async function open(query, { width = 900, dark = false } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 1200 } });
  const errors = [];
  const toasts = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => (m.type() === 'error' ? errors.push(m.text()) : toasts.push(m.text())));
  await page.goto(`http://localhost:8765/?${new URLSearchParams({ ...query, ...(dark ? { dark: '1' } : {}) })}`);
  await page.waitForTimeout(500);
  opened.push({ page, errors });
  return { page, errors, toasts };
}
const click = async (page, selector) => { await page.click(selector); await page.waitForTimeout(250); };
const config = (page) => page.evaluate(() => window.__config());
const selectedLibraries = (page) => page.$$eval('[data-action=toggle-library][aria-pressed=true]', (els) => els.map((e) => e.dataset.id));
const libs = (sensor) => sensor.filters.libraries;

async function flow(name, fn) {
  opened = [];
  try {
    await fn();
    const errors = opened.flatMap((o) => o.errors);
    assert.deepEqual(errors, [], 'no errors on the page');
    results.push(`PASS ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}: ${error.message.split('\n').slice(0, 6).join(' ')}`);
  } finally {
    await Promise.all(opened.map((o) => o.page.close().catch(() => {})));
  }
}

/** Types into an input or select and fires change, as a user leaving the field does. */
async function setField(page, selector, value) {
  const tag = await page.$eval(selector, (el) => el.tagName);
  if (tag === 'SELECT') {
    await page.selectOption(selector, value);
  } else {
    await page.fill(selector, String(value));
    await page.dispatchEvent(selector, 'change');
  }
  await page.waitForTimeout(200);
}

const existing = (serverIds, libraries) => JSON.stringify({
  platform: 'PlexIntermission', name: 'Intermission', setupId: 'x',
  servers: serverIds.map((id) => ({ id, name: id === 'srv' ? 'Unraid' : 'Cabin', url: `http://${id}` })),
  selection: { players: [{ id: 'ATV', name: 'Living Room' }], allUsers: true, users: [], allPlayers: false, allLibraries: false,
    libraries: libraries.map((key) => ({ key, title: key, kind: key.endsWith('/2') ? 'show' : 'movie', serverId: key.split('/')[0], serverName: key.split('/')[0] })) },
  sensors: ['playing', 'paused', 'credits', 'idle'].map((state) => ({ id: state, name: state, type: 'occupancy', state, filters: { players: ['ATV'], users: [], libraries: [...libraries] } })),
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

await flow('Diagnostics Copy works inside a frame that is not allowed the Clipboard API', async () => {
  // Homebridge shows settings in a frame. A frame from another origin, with no clipboard permission, is the worst case.
  const context = await browser.newContext();
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:8765' });
  const top = await context.newPage();
  await top.goto('http://127.0.0.1:8765/?s=signin');
  await top.evaluate(() => { document.body.innerHTML = '<iframe id="f" src="http://localhost:8765/?s=advanced" style="width:900px;height:1200px"></iframe>'; });
  await top.waitForTimeout(1200);
  const frame = top.frame({ url: /localhost:8765/ });
  const paste = () => top.evaluate(() => navigator.clipboard.readText());
  await frame.click('[data-action=tab][data-id=advanced]');
  await top.evaluate(() => navigator.clipboard.writeText('before'));
  await frame.click('[data-action=copy-diagnostics]');
  await top.waitForTimeout(600);
  let text = await paste();
  if (text === 'before') {
    assert.ok(await frame.$('.im-report'), 'the text is shown when the first press could not copy');
    await frame.click('[data-action=copy-diagnostics]');
    await top.waitForTimeout(300);
    text = await paste();
  }
  assert.match(text, /^Intermission diagnostics/, 'copied the report');
  assert.match(text, /Title 1, Player 1/);
  await frame.check('[data-include-names]');
  await top.waitForTimeout(200);
  await frame.click('[data-action=copy-diagnostics]');
  await top.waitForTimeout(600);
  text = await paste();
  if (!/Dune/.test(text)) {
    await frame.click('[data-action=copy-diagnostics]');
    await top.waitForTimeout(300);
    text = await paste();
  }
  assert.match(text, /Dune: Part Two/, 'a changed name setting is not served from the old text');
  await context.close();
});

/* ---------- Every setting, as a user would change it ---------- */

const settingsTab = async (page) => {
  await click(page, '[data-action=tab][data-id=advanced]');
};
const openSection = async (page, id) => {
  if (await page.$(`[data-action=toggle-open][data-id=${id}][aria-expanded=false]`)) {
    await click(page, `[data-action=toggle-open][data-id=${id}]`);
  }
};

await flow('Settings: every timing field saves within its range, and defaults are left out', async () => {
  const { page } = await open({ s: 'main' });
  await settingsTab(page);
  await openSection(page, 'advanced');
  const timing = async () => (await config(page)).timing ?? {};
  const cases = [
    ['creditsOffset', 200, 120], ['creditsOffset', 30, 30], ['creditsOffset', 0, undefined],
    ['rearmDistance', 5, 20], ['rearmDistance', 90, 90], ['rearmDistance', 60, undefined],
    ['pauseDebounce', 2.2, 2], ['pauseDebounce', -1, 0], ['pauseDebounce', 1.3, undefined],
    ['stopHold', 61, 60], ['stopHold', '', undefined], ['stopHold', 4, 4],
    ['minItemLength', 5, 300], ['minItemLength', 0, undefined],
    ['safetyResync', 0, 0], ['safetyResync', 31, 30], ['safetyResync', 5, undefined],
  ];
  for (const [key, typed, stored] of cases) {
    await setField(page, `#im-${key}`, typed);
    assert.equal((await timing())[key], stored, `${key} typed ${typed}`);
  }
  assert.ok(await page.$('.im-banner-info'), 'unsaved changes are announced');
});

await flow('Settings: credits, fallback, webhook options and detailed logging', async () => {
  const { page } = await open({ s: 'main' });
  await settingsTab(page);
  await setField(page, '[data-credits-mode]', 'final');
  assert.equal((await config(page)).timing.midCredits, 'final');
  await setField(page, '[data-credits-mode]', 'scenes');
  assert.equal((await config(page)).timing.midCredits, undefined, 'the default is not stored');

  await setField(page, '[data-fallback]', 'off');
  assert.equal((await config(page)).timing.fallbackPercent, null);
  assert.equal(await page.$('[data-fallback-percent]'), null, 'no percentage while off');
  await setField(page, '[data-fallback]', 'percent');
  assert.equal('fallbackPercent' in ((await config(page)).timing ?? {}), false);
  for (const [typed, stored] of [[49, 50], [120, 99], [90, 90], [95, undefined]]) {
    await setField(page, '[data-fallback-percent]', typed);
    assert.equal((await config(page)).timing.fallbackPercent, stored, `fallback ${typed}`);
  }

  await openSection(page, 'webhook-options');
  await page.uncheck('#im-webhook');
  await page.waitForTimeout(200);
  assert.equal((await config(page)).webhook.enabled, false);
  await page.check('#im-webhook');
  await page.waitForTimeout(200);
  assert.equal((await config(page)).webhook.enabled, true);
  for (const [typed, stored] of [[80, 32550], [40000, 40000], [70000, 32550], [32551, 32551]]) {
    await setField(page, '#im-port', typed);
    assert.equal((await config(page)).webhook.port, stored, `port ${typed}`);
  }
  await setField(page, '#im-address', '  http://10.0.0.5:32550  ');
  assert.equal((await config(page)).webhook.advertisedUrl, 'http://10.0.0.5:32550');
  await setField(page, '#im-address', '');
  assert.equal((await config(page)).webhook.advertisedUrl, undefined);

  await openSection(page, 'advanced');
  await page.check('#im-detailed');
  await page.waitForTimeout(200);
  assert.equal((await config(page)).detailedLogging, true);
  await page.uncheck('#im-detailed');
  await page.waitForTimeout(200);
  assert.equal((await config(page)).detailedLogging, false);
});

await flow('Settings: Reset all settings needs two taps and clears only settings', async () => {
  const { page } = await open({ s: 'main' });
  await settingsTab(page);
  await openSection(page, 'advanced');
  await setField(page, '#im-stopHold', 20);
  await page.check('#im-detailed');
  await openSection(page, 'reset');
  await click(page, '[data-action=reset-advanced]');
  assert.equal((await config(page)).timing.stopHold, 20, 'one tap only asks');
  await click(page, '[data-action=reset-advanced]');
  const c = await config(page);
  assert.equal(c.timing, undefined);
  assert.equal(c.detailedLogging, undefined);
  assert.equal(c.sensors.length, 5, 'sensors stay');
});

await flow('Settings: Reset Intermission keeps the bridge, clears the rest and closes the settings', async () => {
  const { page } = await open({ s: 'main' });
  await settingsTab(page);
  await openSection(page, 'reset');
  await click(page, '[data-action=reset-plugin]');
  await click(page, '[data-action=cancel-confirm]');
  assert.equal((await config(page)).sensors.length, 5, 'Cancel keeps everything');
  await click(page, '[data-action=reset-plugin]');
  await click(page, '[data-action=reset-plugin]');
  await page.waitForTimeout(300);
  const c = await config(page);
  assert.deepEqual(c.sensors, []);
  assert.equal(c.servers, undefined);
  assert.equal(c._bridge.username, '0E:12:34:56:78:9A', 'the child bridge already in Home is kept');
  assert.equal(await page.evaluate(() => window.__closed), true);
});

await flow('Commands: add, name, test, attach to a sensor; removing one cleans up the sensors', async () => {
  const { page } = await open({ s: 'main' });
  await settingsTab(page);
  await openSection(page, 'advanced');
  await page.check('#im-commands');
  await page.waitForTimeout(200);
  await click(page, '[data-action=add-command]');
  const id = (await config(page)).commands.list[0].id;
  assert.match(id, /^c-[0-9a-f]{8}$/);
  assert.ok(await page.$(`[data-action=test-command][data-id="${id}"][disabled]`), 'Test waits for a command line');
  await setField(page, `[data-command-name="${id}"]`, ' Lens memory ');
  await setField(page, `[data-command-line="${id}"]`, 'curl -s http://projector.local/lens?memory=2');
  await click(page, `[data-action=test-command][data-id="${id}"]`);
  await page.waitForTimeout(200);
  assert.match(await page.textContent('.im-command'), /Worked/);
  assert.deepEqual((await config(page)).commands.list[0], { id, name: 'Lens memory', command: 'curl -s http://projector.local/lens?memory=2' });

  await click(page, '[data-action=tab][data-id=sensors]');
  await click(page, '[data-action=edit][data-id=s-6]');
  await click(page, `[data-action=toggle-run][data-when=on][data-id="${id}"]`);
  await click(page, `[data-action=toggle-run][data-when=off][data-id="${id}"]`);
  let wide = (await config(page)).sensors.find((x) => x.id === 's-6');
  assert.deepEqual([wide.run.on, wide.run.off], [[id], [id]]);

  await settingsTab(page);
  await openSection(page, 'advanced');
  await click(page, `[data-action=remove-command][data-id="${id}"]`);
  await click(page, `[data-action=remove-command][data-id="${id}"]`);
  const c = await config(page);
  wide = c.sensors.find((x) => x.id === 's-6');
  assert.deepEqual(c.commands.list, []);
  assert.deepEqual([wide.run.on, wide.run.off], [[], []], 'sensors no longer run the removed command');
  await page.uncheck('#im-commands');
  await page.waitForTimeout(200);
  assert.equal((await config(page)).commands.enabled, false);
});

await flow('Sensor editor: names, types, states, exceptions, events, filters and removal', async () => {
  const { page, toasts } = await open({ s: 'main' });
  await click(page, '[data-action=add][data-type=occupancy]');
  let c = await config(page);
  let sensor = c.sensors.at(-1);
  assert.deepEqual(sensor.filters, { players: ['ATV'], users: [], libraries: ['srv/1', 'srv/2'] }, 'a new sensor starts from the setup choices');
  const get = async () => (await config(page)).sensors.find((x) => x.id === sensor.id);

  await setField(page, '#im-name', '🎬 Movie Night!');
  assert.equal((await get()).name, 'Movie Night');
  assert.ok(toasts.some((t) => t.includes('Saved as "Movie Night"')), 'says the name was cleaned');
  assert.equal(await page.inputValue('#im-name'), 'Movie Night');
  await setField(page, '#im-name', '   ');
  assert.equal((await get()).name, 'Movie Night', 'an empty name keeps the old one');

  await setField(page, '#im-state', 'credits');
  assert.deepEqual((await get()).except, [], 'In the credits has no exceptions');
  assert.equal(await page.$('[data-action=toggle-except]'), null);
  await setField(page, '#im-state', 'active');
  await click(page, '[data-action=toggle-except][data-id=intro]');
  await click(page, '[data-action=toggle-except][data-id=credits]');
  assert.deepEqual((await get()).except.sort(), ['credits', 'intro']);
  assert.ok(await page.$('.im-credits'), 'the shared credits choice shows for a sensor that follows the credits');

  await click(page, '[data-action=set-type][data-id=button]');
  sensor = await get();
  assert.deepEqual([sensor.type, sensor.events, sensor.state], ['button', ['play'], undefined]);
  await click(page, '[data-action=toggle-event][data-id="credits.start"]');
  await click(page, '[data-action=toggle-event][data-id=play]');
  assert.deepEqual((await get()).events, ['credits.start']);
  await click(page, '[data-action=set-type][data-id=contact]');
  sensor = await get();
  assert.deepEqual([sensor.type, sensor.state, sensor.except], ['contact', 'playing', ['credits']]);

  await click(page, '[data-action=toggle-filter-players][data-id=LG]');
  assert.deepEqual((await get()).filters.players, ['ATV', 'LG']);
  await click(page, '[data-action=filter-all][data-id=players]');
  assert.deepEqual((await get()).filters.players, []);
  await click(page, '[data-action=toggle-filter-users][data-id=Jen]');
  assert.deepEqual((await get()).filters.users, ['Jen']);
  await click(page, '[data-action=toggle-filter-libraries][data-id="srv/3"]');
  assert.deepEqual((await get()).filters.libraries, ['srv/1', 'srv/2', 'srv/3']);

  await click(page, `[data-action=delete][data-id="${sensor.id}"]`);
  await click(page, '[data-action=cancel-confirm]');
  assert.ok(await get(), 'Keep it keeps the sensor');
  await click(page, `[data-action=delete][data-id="${sensor.id}"]`);
  await click(page, `[data-action=delete][data-id="${sensor.id}"]`);
  assert.equal(await get(), undefined);
  c = await config(page);
  assert.equal(c.sensors.length, 5);
});

await flow('Drag to reorder sensors', async () => {
  const { page } = await open({ s: 'main' });
  await page.dragAndDrop('.im-sensor[data-index="4"]', '.im-sensor[data-index="0"]');
  await page.waitForTimeout(300);
  assert.deepEqual((await config(page)).sensors.map((x) => x.id), ['s-6', 's-1', 's-3', 's-4', 's-5']);
});

await flow('Guide follows the presets in use as sensors change', async () => {
  const { page } = await open({ s: 'main' });
  await click(page, '[data-action=remove-group]');
  await click(page, '[data-action=remove-group]');
  await click(page, '[data-action=tab][data-id=recipes]');
  assert.deepEqual(await page.$$eval('[data-preset]', (els) => els.map((el) => el.dataset.preset)), ['simple', 'credits', 'states'], 'none in use: all shown');
  await click(page, '[data-action=pick-preset][data-id=credits]');
  await click(page, '[data-action=preset-alongside]');
  await click(page, '[data-action=tab][data-id=recipes]');
  assert.deepEqual(await page.$$eval('[data-preset]', (els) => els.map((el) => el.dataset.preset)), ['credits'], 'the preset in use comes first');
  await click(page, '[data-action=zoom-shot]');
  assert.ok(await page.$('.im-shot-zoom'), 'a screenshot enlarges on tap');
});

await flow('Diagnostics: Show, include names, Download', async () => {
  const { page } = await open({ s: 'main' });
  await settingsTab(page);
  await click(page, '[data-action=show-diagnostics]');
  await page.waitForTimeout(200);
  assert.match(await page.inputValue('.im-report'), /Title 1, Player 1/);
  await page.check('[data-include-names]');
  await page.waitForTimeout(200);
  assert.equal(await page.$('.im-report'), null, 'old text is cleared when the choice changes');
  const download = page.waitForEvent('download');
  await click(page, '[data-action=download-diagnostics]');
  const file = await download;
  assert.match(file.suggestedFilename(), /^intermission-diagnostics-\d{4}-\d{2}-\d{2}\.txt$/);
  assert.match(await page.inputValue('.im-report'), /Dune: Part Two/);
});

await flow('Webhooks: remove an old address, add Intermission\'s, remove it again', async () => {
  const { page } = await open({ s: 'main' });
  await settingsTab(page);
  assert.ok(await page.$('.im-removing'), 'the old Intermission address is marked for removal by default');
  await click(page, '[data-action=apply-webhooks]');
  await page.waitForTimeout(300);
  assert.match(await page.textContent('#im-webhooks'), /Intermission ✓/);
  await click(page, '[data-action=remove-webhook]');
  await click(page, '[data-action=remove-webhook]');
  await page.waitForTimeout(300);
  assert.doesNotMatch(await page.textContent('#im-webhooks'), /Intermission ✓/);
});

await flow('Sign out needs two taps and returns to sign-in', async () => {
  const { page } = await open({ s: 'main' });
  await settingsTab(page);
  await click(page, '[data-action=signout]');
  assert.ok(await page.$('[data-action=signout].btn-danger'), 'first tap asks');
  await click(page, '[data-action=signout]');
  await page.waitForTimeout(300);
  assert.ok(await page.$('[data-action=signin-browser]'));
  assert.equal(await page.title(), 'save:off', 'Homebridge Save waits while signed out');
});

await flow('Sign-in with a code shows the code and waits', async () => {
  const { page } = await open({ s: 'signin' });
  await click(page, '[data-action=signin-code]');
  await page.waitForTimeout(200);
  assert.equal(await page.textContent('.im-code'), 'K7QX');
});

await flow('Every screen in light and dark, at desktop and phone width: no errors and no sideways scrolling', async () => {
  const screens = [
    ['signin', []], ['server', []], ['choose', []], ['webhooks', []],
    ['main', []], ['main', ['[data-action=edit][data-id=s-6]']], ['main', ['[data-action=toggle-presets]']],
    ['main', ['[data-action=tab][data-id=recipes]', '[data-action=toggle-open][data-id=other-presets]']],
    ['advanced', ['[data-action=tab][data-id=advanced]', '[data-action=toggle-open][data-id=webhook-options]', '[data-action=toggle-open][data-id=advanced]', '[data-action=toggle-open][data-id=reset]', '[data-action=show-diagnostics]']],
    ['commands', ['[data-action=tab][data-id=advanced]', '[data-action=toggle-open][data-id=advanced]']],
    ['ended', []], ['nopass-adv', ['[data-action=tab][data-id=advanced]']],
  ];
  for (const width of [900, 375]) {
    for (const dark of [false, true]) {
      for (const [s, steps] of screens) {
        const { page } = await open({ s }, { width, dark });
        for (const step of steps) {
          await click(page, step);
        }
        const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(wide <= 0, `${s} ${steps.join(' ')} at ${width}px${dark ? ' dark' : ''} scrolls sideways by ${wide}px`);
        await page.close();
      }
    }
  }
});

console.log(results.join('\n'));
await browser.close();
