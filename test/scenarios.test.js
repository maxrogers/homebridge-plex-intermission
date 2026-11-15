// Whole-plugin scenarios: the real platform against a fake Plex server and plex.tv (see world.js),
// one test per setup people are likely to have.
import assert from 'node:assert/strict';
import test from 'node:test';

import { everyState, freePort, PLAYERS, sensor, sleep, startHome, startPlex, until } from './world.js';

const { tv, infuse, bedroom, phone, web, away } = PLAYERS;
const ALL = ['Media Playing', 'Media Paused', 'Credits Rolling', 'Nothing Playing'];

test('without Plex Pass: Every State follows play, pause, credits and stop from notifications alone', async (t) => {
  const { plex, plexTv, server } = await startPlex(t);
  plexTv.plexPass = false;
  const home = await startHome(t, { plexTv, config: { servers: [server], sensors: everyState() } });
  await home.waitActive(['Nothing Playing']);
  assert.ok(home.logged(/No Plex Pass/, 'info'));
  assert.ok(!home.logged(/Listening for Plex webhooks/), 'no webhook receiver without Plex Pass');

  await plex.play(tv, 'short', { offset: 0 });
  await home.waitActive(['Media Playing']);
  await plex.pause(tv);
  await home.waitActive(['Media Paused']);
  await plex.resume(tv);
  await home.waitActive(['Media Playing']);
  plex.seek(tv, 1_800);
  await home.waitActive(['Credits Rolling']);
  await plex.stop_(tv);
  await home.waitActive(['Nothing Playing']);
  assert.deepEqual(home.names(), [...ALL].sort());
  assert.deepEqual(home.problems(), []);
});

test('with Plex Pass: a webhook starts playback before any notification, and a poster in the webhook is fine', async (t) => {
  const { plex, plexTv, server } = await startPlex(t);
  const port = await freePort();
  plex.webhookUrl = `http://127.0.0.1:${port}/secret0123456789`;
  const home = await startHome(t, { plexTv, config: { servers: [server], webhook: { port }, sensors: [...everyState(), { id: 'b', name: 'New Movie', type: 'button', events: ['library.new'] }] } });
  await home.waitLog(/Listening for Plex webhooks/);
  await home.waitActive(['Nothing Playing']);

  await plex.play(tv, 'movie', { notify: false });
  await home.waitActive(['Media Playing']);
  const presses = home.presses('New Movie');
  assert.equal(await plex.webhook('library.new', undefined), 200);
  await until(() => presses.count === 1, 'the button press');
  assert.equal(await plex.webhook('media.play', plex.sessions.get(tv.id), { thumbBytes: 3_000_000 }), 200, 'a 3 MB poster is accepted');
  const wrong = await fetch(`http://127.0.0.1:${port}/not-the-key`, { method: 'POST', body: '{}' });
  assert.equal(wrong.status, 404, 'requests without the key are refused');
  await plex.stop_(tv);
  await home.waitActive(['Nothing Playing']);
  assert.deepEqual(home.problems(), []);
});

test('plex.tv unreachable at start: the plugin still runs, webhooks included', async (t) => {
  const { plex, plexTv, server } = await startPlex(t);
  plexTv.failWith = 503;
  const port = await freePort();
  plex.webhookUrl = `http://127.0.0.1:${port}/secret0123456789`;
  const home = await startHome(t, { plexTv, config: { servers: [server], webhook: { port }, sensors: everyState() } });
  await home.waitActive(['Nothing Playing']);
  assert.ok(home.logged(/Cannot reach plex\.tv/, 'warn'));
  await plex.play(tv, 'movie', { notify: false });
  await home.waitActive(['Media Playing']);
  assert.deepEqual(home.problems(), []);
});

test('sign-in rejected by plex.tv: one clear error, sensors stay as they were, nothing crashes', async (t) => {
  const { plexTv, server } = await startPlex(t);
  plexTv.failWith = 401;
  const home = await startHome(t, { plexTv, config: { servers: [server], sensors: everyState() } });
  await home.waitLog(/Plex no longer accepts the saved sign-in/);
  assert.deepEqual(home.names(), [...ALL].sort(), 'sensors still exist, so Home automations keep their triggers');
  assert.deepEqual(home.active(), []);
  assert.equal(home.lines.filter((line) => line.startsWith('error')).length, 1);
});

test('sign-in rejected by the Plex server: reported once, and retried quietly', async (t) => {
  const { plex, plexTv, server } = await startPlex(t, { token: 'another-token' });
  const home = await startHome(t, { plexTv, config: { servers: [server], sensors: everyState() } });
  await home.waitLog(/Plex no longer accepts the saved sign-in/);
  await sleep(300);
  assert.equal(home.lines.filter((line) => line.startsWith('error')).length, 1, home.lines.filter((line) => line.startsWith('error')).join('\n'));
  assert.ok(plex.requests.length > 0);
});

test('before sign-in: sensors exist and the log says what to do', async (t) => {
  const home = await startHome(t, { signedIn: false, config: { sensors: everyState() } });
  await home.waitLog(/Not signed in to Plex yet/);
  assert.deepEqual(home.names(), [...ALL].sort());
  assert.deepEqual(home.problems(), []);
});

test('Plex server off at start, then on: connects by itself and reads what is playing', async (t) => {
  const { plex, plexTv, server } = await startPlex(t);
  const port = plex.port;
  await plex.stop();
  const home = await startHome(t, { plexTv, config: { servers: [server], sensors: everyState() } });
  await home.waitLog(/cannot connect/);
  assert.deepEqual(home.active(), [], 'nothing is known yet, so nothing is claimed');
  await plex.start(port);
  await plex.play(tv, 'movie', { notify: false });
  await home.waitActive(['Media Playing']);
  assert.ok(home.logged(/Connected to Plex/, 'info'));
  assert.deepEqual(home.problems(), []);
});

test('Plex server restarts mid-movie: no flicker, and a stop missed meanwhile is caught on reconnect', async (t) => {
  const { plex, plexTv, server } = await startPlex(t);
  const home = await startHome(t, { plexTv, config: { servers: [server], sensors: everyState() } });
  await plex.play(tv, 'movie');
  await home.waitActive(['Media Playing']);
  const port = plex.port;
  const changes = [];
  const watch = setInterval(() => changes.push(home.active().join()), 10);
  t.after(() => clearInterval(watch));
  await plex.stop();
  await home.waitLog(/Lost the connection/);
  await sleep(150);
  assert.deepEqual([...new Set(changes)], ['Media Playing'], 'the state holds while Plex is away');
  plex.sessions.clear();
  await plex.start(port);
  await home.waitActive(['Nothing Playing']);
  assert.deepEqual(home.problems(), []);
});

test('Plex server moved to a new address: found through plex.tv at start, and while running', async (t) => {
  const { plex, plexTv, server } = await startPlex(t);
  const old = server.url;
  await plex.stop();
  await plex.start(0);
  plexTv.lists(plex, [old, plex.url]);
  const home = await startHome(t, { plexTv, stream: { downMs: 200 }, config: { servers: [server], sensors: everyState() } });
  await home.waitLog(/is not at its saved address; found it at/);
  await plex.play(tv, 'movie');
  await home.waitActive(['Media Playing']);

  // It moves again while Homebridge runs.
  const second = plex.url;
  await plex.stop();
  await plex.start(0);
  plexTv.lists(plex, [old, second, plex.url]);
  await home.waitLog(/Plex moved to/, 6_000);
  await plex.stop_(tv);
  await home.waitActive(['Nothing Playing']);
  assert.equal(home.lines.filter((line) => /Plex moved to/.test(line)).length, 1);
  assert.deepEqual(home.problems(), []);
});

test('a connection that goes silent is replaced, and what happened meanwhile is read', async (t) => {
  const { plex, plexTv, server } = await startPlex(t);
  const home = await startHome(t, { plexTv, stream: { silenceMs: 150 }, config: { servers: [server], sensors: everyState() } });
  await home.waitActive(['Nothing Playing']);
  plex.freeze();
  await plex.play(tv, 'movie');
  await home.waitActive(['Media Playing']);
  assert.ok(!home.logged(/Lost the connection/), 'replacing a quiet connection is not an outage');
  assert.deepEqual(home.problems(), []);
});

test('webhook port taken by another app: an error says so, and notifications still work', async (t) => {
  const { plex, plexTv, server } = await startPlex(t);
  const { createServer } = await import('node:http');
  const other = createServer();
  await new Promise((resolve) => other.listen(0, resolve));
  t.after(() => other.close());
  const home = await startHome(t, { plexTv, config: { servers: [server], webhook: { port: other.address().port }, sensors: everyState() } });
  await home.waitLog(/Cannot receive Plex webhooks: port \d+ is in use/);
  await plex.play(tv, 'movie');
  await home.waitActive(['Media Playing']);
});

const playingOn = (filters, extra = {}) => [sensor('playing', 'active', { name: 'Media On', filters, ...extra })];
/** Plays on `player` and reports whether the sensor turned on, then stops. */
async function counts(home, plex, player, key = 'movie', options = {}) {
  await plex.play(player, key, options);
  const on = await home.waitActive(['Media On'], 700).then(() => true, () => false);
  await plex.stop_(player);
  await home.waitActive([]);
  return on;
}

test('two servers: a sensor is on while either plays, and Nothing Playing only while both are idle', async (t) => {
  const main = await startPlex(t, { id: 'server-1', name: 'Unraid' });
  const cabin = await startPlex(t, { id: 'server-2', name: 'Cabin', plexTv: main.plexTv });
  const port = await freePort();
  main.plex.webhookUrl = cabin.plex.webhookUrl = `http://127.0.0.1:${port}/secret0123456789`;
  const home = await startHome(t, { plexTv: main.plexTv, config: { servers: [main.server, cabin.server], webhook: { port }, sensors: everyState() } });
  await home.waitActive(['Nothing Playing']);
  await main.plex.play(tv, 'movie');
  await home.waitActive(['Media Playing']);
  await cabin.plex.play(phone, 'episode');
  await sleep(100);
  await main.plex.stop_(tv);
  await sleep(150);
  assert.deepEqual(home.active(), ['Media Playing'], 'the other server still plays');
  await cabin.plex.pause(phone);
  await home.waitActive(['Media Paused']);
  await cabin.plex.stop_(phone);
  await home.waitActive(['Nothing Playing']);
  assert.ok(home.logged(/Unraid: /) && home.logged(/Cabin: /), 'log lines say which server');
  assert.deepEqual(home.problems(), []);
});

test('a server shared with you uses its own token', async (t) => {
  const { plex, plexTv, server } = await startPlex(t, { token: 'shared-token' });
  const home = await startHome(t, { plexTv, serverTokens: { [server.id]: 'shared-token' }, config: { servers: [server], sensors: playingOn({}) } });
  assert.equal(await counts(home, plex, tv), true);
  assert.deepEqual(home.problems(), []);
});

test('people: only the chosen users count, managed users included', async (t) => {
  const { plex, plexTv, server } = await startPlex(t);
  const home = await startHome(t, { plexTv, config: { servers: [server], sensors: playingOn({ users: ['Steve', 'Kids'] }) } });
  assert.equal(await counts(home, plex, tv, 'movie', { user: 'Steve' }), true);
  assert.equal(await counts(home, plex, tv, 'movie', { user: 'Kids' }), true);
  assert.equal(await counts(home, plex, tv, 'movie', { user: 'Guest' }), false);
});

test('libraries: Movies only, by server; Live TV as its own choice', async (t) => {
  const { plex, plexTv, server } = await startPlex(t);
  plex.liveTv = true;
  const home = await startHome(t, { plexTv, config: { servers: [server], sensors: [
    ...playingOn({ libraries: ['server-1/1'] }),
    sensor('live', 'active', { name: 'Live TV On', filters: { libraries: ['server-1/livetv'] } }),
    sensor('elsewhere', 'active', { name: 'Other Server', filters: { libraries: ['server-9/1'] } }),
  ] } });
  await home.waitActive([]);
  await plex.play(tv, 'movie');
  await home.waitActive(['Media On']);
  await plex.stop_(tv);
  await home.waitActive([]);
  await plex.play(tv, 'episode');
  await sleep(300);
  assert.deepEqual(home.active(), [], 'TV Shows are not chosen');
  await plex.stop_(tv);
  await plex.play(tv, 'news');
  await home.waitActive(['Live TV On']);
  await plex.stop_(tv);
  await home.waitActive([]);
  assert.deepEqual(home.problems(), []);
});

test('credits: from the marker; never for Other Videos, music or Live TV; 95% without a marker', async (t) => {
  const { plex, plexTv, server } = await startPlex(t);
  plex.items.set('nomarker', { title: 'Old Film', type: 'movie', duration: 100_000, section: '1' });
  const home = await startHome(t, { plexTv, config: { servers: [server], sensors: everyState() } });
  await home.waitActive(['Nothing Playing']);
  for (const [key, offset, want] of [['movie', 499_900, 'Credits Rolling'], ['nomarker', 94_900, 'Credits Rolling'], ['home', 59_000, 'Media Playing'], ['song', 179_000, 'Media Playing'], ['news', 1_790_000, 'Media Playing']]) {
    await plex.play(tv, key, { offset });
    await home.waitActive([want], 2_000).catch((error) => assert.fail(`${key}: ${error.message}`));
    if (want === 'Media Playing') {
      await sleep(250);
      assert.deepEqual(home.active(), ['Media Playing'], `${key} never reaches credits`);
    }
    await plex.stop_(tv);
    await home.waitActive(['Nothing Playing']);
  }
  assert.deepEqual(home.problems(), []);
});

test('a device: every app on it at home counts, a left-out app and other devices do not', async (t) => {
  const { plex, plexTv, server } = await startPlex(t);
  const devices = [{ id: 'd-1', name: 'Living Room', match: 'Apple TV' }];
  const home = await startHome(t, { plexTv, config: { servers: [server], devices, sensors: playingOn({ devices: ['d-1'], exceptPlayers: ['KIDS-APP'] }) } });
  await home.waitActive([]);
  assert.equal(await counts(home, plex, tv), true, 'the Plex app');
  assert.equal(await counts(home, plex, infuse), true, 'another app, never chosen by ID');
  assert.equal(await counts(home, plex, { ...tv, id: 'NEW-INSTALL' }), true, 'a reinstalled app with a new ID');
  assert.equal(await counts(home, plex, { ...tv, id: 'KIDS-APP', product: 'Kids' }), false, 'an app left out');
  assert.equal(await counts(home, plex, phone), false, 'another device');
  assert.equal(await counts(home, plex, away), false, 'a same-named device outside the home');
  assert.equal(await counts(home, plex, { ...tv, id: 'BRIDGED', local: false, address: '192.168.1.44' }), true, 'Plex in a Docker bridge calls home players remote; a private address still counts');
  assert.deepEqual(home.problems(), []);
});

test('a device with Plex Pass: the webhook alone (no address yet) is enough when Plex calls the player local', async (t) => {
  const { plex, plexTv, server } = await startPlex(t);
  const port = await freePort();
  plex.webhookUrl = `http://127.0.0.1:${port}/secret0123456789`;
  const devices = [{ id: 'd-1', name: 'Living Room', match: 'Apple TV' }];
  const home = await startHome(t, { plexTv, config: { servers: [server], webhook: { port }, devices, sensors: playingOn({ devices: ['d-1'] }) } });
  await home.waitLog(/Listening for Plex webhooks/);
  await plex.play(tv, 'movie', { notify: false });
  await home.waitActive(['Media On']);
  await plex.stop_(tv);
  await home.waitActive([]);
  // In a Docker bridge the webhook says "not local"; the address from the session list settles it.
  await plex.play({ ...tv, id: 'BRIDGED', local: false, address: '172.17.0.5' }, 'movie', { notify: false });
  await home.waitActive(['Media On']);
});

test('All players: anything counts, at home or away', async (t) => {
  const { plex, plexTv, server } = await startPlex(t);
  const home = await startHome(t, { plexTv, config: { servers: [server], sensors: playingOn({}) } });
  await home.waitActive([]);
  for (const player of [tv, phone, web, away]) {
    assert.equal(await counts(home, plex, player), true, player.id);
  }
});

test('two Apple TVs with one name: both count until one is chosen with This one; the log points it out', async (t) => {
  const { plex, plexTv, server } = await startPlex(t);
  const config = (devices) => ({ servers: [server], devices, sensors: playingOn({ devices: ['d-1'] }) });
  const home = await startHome(t, { plexTv, config: config([{ id: 'd-1', name: 'Apple TV', match: 'Apple TV' }]) });
  await home.waitActive([]);
  assert.equal(await counts(home, plex, tv), true);
  assert.equal(await counts(home, plex, bedroom), true, 'the bedroom Apple TV reports the same name');
  assert.equal(await counts(home, plex, tv), true);
  await home.waitLog(/Two devices report the player name Apple TV/);
  await home.shutdown();

  // After This one: the device is narrowed to the apps seen at the living room address.
  const narrowed = await startHome(t, { plexTv, previous: home, config: config([{ id: 'd-1', name: 'Living Room', match: 'Apple TV', apps: [tv.id] }]) });
  assert.equal(await counts(narrowed, plex, tv), true);
  assert.equal(await counts(narrowed, plex, bedroom), false);
  assert.equal(await counts(narrowed, plex, infuse), true, 'another app at the living room address joins by itself');
  assert.ok(narrowed.logged(/has a new Plex ID/, 'info'));
  assert.deepEqual(narrowed.problems(), []);
});

test('a 1.0 config (apps chosen by ID) keeps working, and a reinstalled app is followed', async (t) => {
  const { plex, plexTv, server } = await startPlex(t);
  const home = await startHome(t, { plexTv, config: {
    servers: [server],
    selection: { players: [{ id: tv.id, name: 'Apple TV', product: 'Plex for Apple TV' }] },
    sensors: playingOn({ players: [tv.id] }),
  } });
  await home.waitActive([]);
  assert.equal(await counts(home, plex, tv), true);
  assert.equal(await counts(home, plex, infuse), false, 'another app was never chosen');
  assert.ok(!home.logged(/no sensor watches it/), 'a different app is not pointed out');
  assert.equal(await counts(home, plex, { ...tv, id: 'REINSTALLED' }), true, 'same name, app and address');
  assert.equal(await counts(home, plex, { ...bedroom, id: 'OTHER-ROOM' }), false);
  assert.ok(home.logged(/is playing, but no sensor watches it/, 'warn'));
  assert.deepEqual(home.problems(), []);
});

test('buttons press once per event; webhook-only buttons stay quiet without Plex Pass', async (t) => {
  const { plex, plexTv, server } = await startPlex(t);
  plexTv.plexPass = false;
  const button = (id, events) => ({ id, name: id, type: 'button', events });
  const home = await startHome(t, { plexTv, config: { servers: [server], sensors: [
    button('Started', ['play', 'resume']), button('Paused', ['pause']), button('Credits', ['credits.start']), button('Stopped', ['stop']), button('Scrobbled', ['media.scrobble']),
  ] } });
  await home.waitLog(/Connected to/);
  const count = Object.fromEntries(['Started', 'Paused', 'Credits', 'Stopped', 'Scrobbled'].map((name) => [name, home.presses(name)]));
  const presses = () => Object.fromEntries(Object.entries(count).map(([name, c]) => [name, c.count]));
  await plex.play(tv, 'short');
  await until(() => count.Started.count === 1, 'play');
  await plex.pause(tv);
  await until(() => count.Paused.count === 1, 'pause');
  await plex.resume(tv);
  await until(() => count.Started.count === 2, 'resume');
  plex.seek(tv, 1_900);
  await until(() => count.Credits.count === 1, 'credits');
  await plex.stop_(tv);
  await until(() => count.Stopped.count === 1, 'stop');
  await sleep(100);
  assert.deepEqual(presses(), { Started: 2, Paused: 1, Credits: 1, Stopped: 1, Scrobbled: 0 });
});

if (process.env.DEBUG_HANDLES) {
  test.after(async () => {
    await sleep(3000);
    for (const h of process._getActiveHandles()) {
      console.log('HANDLE', h.constructor.name, JSON.stringify(h.address?.() ?? ''), h.remotePort ?? '', h.listening ?? '', h._idleTimeout ?? '', h.hasRef?.());
    }
  });
}

test('Homebridge restarts mid-movie: sensors keep their state, with no flicker, and the pause is still known', async (t) => {
  const { plex, plexTv, server } = await startPlex(t);
  const config = { servers: [server], sensors: everyState() };
  const first = await startHome(t, { plexTv, config });
  await first.waitActive(['Nothing Playing']);
  await plex.play(tv, 'movie');
  await first.waitActive(['Media Playing']);
  await first.shutdown();

  const changes = [];
  const second = await startHome(t, { plexTv, config, previous: first });
  const { Characteristic } = second.api.hap;
  for (const accessory of second.accessories()) {
    accessory.services.forEach((service) => service.getCharacteristic(Characteristic.OccupancyDetected)?.on('change', ({ newValue }) => changes.push(`${accessory.displayName}=${newValue}`)));
  }
  assert.deepEqual(second.active(), ['Media Playing'], 'restored from before the restart');
  await second.waitLog(/Playback read from Plex/);
  await sleep(200);
  assert.deepEqual(changes, [], 'nothing changed while starting during playback');
  await plex.pause(tv);
  await second.waitActive(['Media Paused']);
  await second.shutdown();

  const third = await startHome(t, { plexTv, config, previous: second });
  assert.deepEqual(third.active(), ['Media Paused']);
  await third.waitLog(/Playback read from Plex/);
  await sleep(200);
  assert.deepEqual(third.active(), ['Media Paused'], 'still paused after a restart during a pause');
  await plex.stop_(tv);
  await third.waitActive(['Nothing Playing']);
  assert.deepEqual(third.problems(), []);
});

test('Homebridge restarts after playback ended: the stale state is corrected', async (t) => {
  const { plex, plexTv, server } = await startPlex(t);
  const config = { servers: [server], sensors: everyState() };
  const first = await startHome(t, { plexTv, config });
  await plex.play(tv, 'movie');
  await first.waitActive(['Media Playing']);
  await first.shutdown();
  plex.vanish(tv);
  const second = await startHome(t, { plexTv, config, previous: first });
  await second.waitActive(['Nothing Playing']);
  assert.deepEqual(second.problems(), []);
});

test('autoplay: the next episode, and a trailer before a movie, never pass through Nothing Playing', async (t) => {
  const { plex, plexTv, server } = await startPlex(t);
  plex.items.set('trailer', { title: 'Trailer', type: 'clip', duration: 30_000 });
  // Movies and TV Shows, as setup chooses them: a trailer, which is in no library, still counts.
  const home = await startHome(t, { plexTv, config: { servers: [server], timing: { pauseDebounce: 0, stopHold: 2 }, sensors: everyState({ libraries: [`${server.id}/1`, `${server.id}/2`] }) } });
  await home.waitActive(['Nothing Playing']);
  const seen = new Set();
  const watch = setInterval(() => home.active().forEach((name) => seen.add(name)), 5);
  t.after(() => clearInterval(watch));

  await plex.play(tv, 'episode', { offset: 279_500 });
  await home.waitActive(['Credits Rolling']);
  seen.clear();
  await plex.stop_(tv);
  await sleep(300);
  await plex.play(tv, 'next');
  await home.waitActive(['Media Playing']);
  await sleep(2_300);
  assert.ok(!seen.has('Nothing Playing'), `went through ${[...seen].join(', ')}`);

  await plex.stop_(tv);
  await home.waitActive(['Nothing Playing'], 6_000);
  await plex.play(tv, 'trailer', { offset: 29_000 });
  await home.waitActive(['Media Playing']);
  seen.clear();
  await plex.stop_(tv);
  await sleep(200);
  await plex.play(tv, 'movie');
  await sleep(2_300);
  assert.deepEqual([...seen], ['Media Playing'], 'the movie follows the trailer without a gap');
  assert.deepEqual(home.problems(), []);
});

test('an app that is force-quit never reports a stop: noticed from Plex\'s session list', async (t) => {
  const { plex, plexTv, server } = await startPlex(t);
  const home = await startHome(t, { plexTv, config: { servers: [server], sensors: everyState() }, goneCheckMs: 150 });
  await home.waitActive(['Nothing Playing']);
  await plex.play(tv, 'movie');
  await home.waitActive(['Media Playing']);
  await sleep(500);
  assert.deepEqual(home.active(), ['Media Playing'], 'checks change nothing while it plays');
  plex.vanish(tv);
  await home.waitActive(['Nothing Playing'], 3_000);
  assert.ok(home.logged(/never reported a stop/));
  assert.deepEqual(home.problems(), []);
});

test('two people watching: sensors follow whoever is still playing', async (t) => {
  const { plex, plexTv, server } = await startPlex(t);
  const home = await startHome(t, { plexTv, config: { servers: [server], sensors: everyState() } });
  await home.waitActive(['Nothing Playing']);
  await plex.play(tv, 'movie');
  await plex.play(phone, 'episode', { user: 'Jen' });
  await home.waitActive(['Media Playing']);
  await plex.pause(tv);
  await home.waitActive(['Media Paused', 'Media Playing']);
  await plex.stop_(phone);
  await home.waitActive(['Media Paused']);
  await plex.stop_(tv);
  await home.waitActive(['Nothing Playing']);
  assert.deepEqual(home.problems(), []);
});

test('media conditions: a 4K HDR sensor and a rating sensor follow the item, not the stream', async (t) => {
  const { plex, plexTv, server } = await startPlex(t);
  Object.assign(plex.items.get('movie'), { contentRating: 'R', Media: [{ videoResolution: '4k', aspectRatio: 2.39, Part: [{ Stream: [{ streamType: 1, colorTrc: 'smpte2084' }] }] }] });
  Object.assign(plex.items.get('short'), { contentRating: 'PG', Media: [{ videoResolution: '1080', aspectRatio: 1.78, Part: [{ Stream: [{ streamType: 1 }] }] }] });
  const sensors = [
    sensor('uhd', 'active', { name: 'UHD', media: { resolution: ['4k'], dynamicRange: ['hdr'] } }),
    sensor('wide', 'active', { name: 'Wide', media: { shape: 'wide' } }),
    sensor('family', 'active', { name: 'Family', media: { ratings: ['G', 'PG'] } }),
  ];
  const home = await startHome(t, { plexTv, config: { servers: [server], sensors } });
  await home.waitActive([]);
  await plex.play(tv, 'movie');
  await home.waitActive(['UHD', 'Wide']);
  await plex.stop_(tv);
  await home.waitActive([]);
  await plex.play(tv, 'short');
  await home.waitActive(['Family']);
  await plex.stop_(tv);
  await home.waitActive([]);
  await plex.play(tv, 'song');
  await sleep(300);
  assert.deepEqual(home.active(), [], 'an item without picture details matches no media condition');
  assert.deepEqual(home.problems(), []);
});

test('commands: run on and off with the title quoted; a failing command is logged and nothing else stops', async (t) => {
  const { mkdtemp, readFile: read, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'intermission-cmd-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = join(dir, 'out.txt');
  const { plex, plexTv, server } = await startPlex(t);
  plex.items.get('movie').title = `It's "Dune"; rm -rf $HOME`;
  const commands = { enabled: true, list: [
    { id: 'on', name: 'On', command: `echo on {title} >> ${out}` },
    { id: 'off', name: 'Off', command: `echo off {player} >> ${out}` },
    { id: 'bad', name: 'Bad', command: 'exit 3' },
  ] };
  const home = await startHome(t, { plexTv, config: { servers: [server], commands, sensors: [sensor('on', 'active', { name: 'Media On', run: { on: ['on', 'bad'], off: ['off'] } })] } });
  await home.waitActive([]);
  await plex.play(tv, 'movie');
  await home.waitActive(['Media On']);
  await plex.stop_(tv);
  await home.waitActive([]);
  await until(async () => (await read(out, 'utf8').catch(() => '')).split('\n').filter(Boolean).length === 2, 'both commands');
  assert.equal(await read(out, 'utf8'), `on It's "Dune"; rm -rf $HOME\noff Apple TV\n`, 'the title is one quoted argument');
  await home.waitLog(/Bad/);
  assert.ok(home.lines.some((line) => /^warn .*Bad/.test(line)), 'the failing command is a warning');
});

test('changing sensors between restarts: renamed and retyped sensors keep their accessory, removed ones go', async (t) => {
  const { plexTv, server } = await startPlex(t);
  const first = await startHome(t, { plexTv, config: { servers: [server], sensors: [sensor('a', 'playing', { name: 'Movie Time' }), sensor('b', 'idle', { name: 'Nothing' }), { id: 'c', name: 'Pressed', type: 'button', events: ['play'] }] } });
  await first.waitActive(['Nothing']);
  const uuid = first.accessories().find((a) => a.displayName === 'Movie Time').UUID;
  await first.shutdown();
  const second = await startHome(t, { plexTv, previous: first, config: { servers: [server], sensors: [sensor('a', 'playing', { name: 'Film Night', type: 'contact' }), { id: 'c', name: 'Pressed', type: 'motion', state: 'active' }] } });
  await second.waitLog(/Watching/);
  assert.deepEqual(second.names(), ['Film Night', 'Pressed']);
  const renamed = second.accessories().find((a) => a.displayName === 'Film Night');
  const { Service } = second.api.hap;
  assert.equal(renamed.UUID, uuid, 'the same accessory, so Home automations survive');
  assert.ok(renamed.getService(Service.ContactSensor) && !renamed.getService(Service.OccupancySensor), 'the service follows the type');
  const was = second.accessories().find((a) => a.displayName === 'Pressed');
  assert.ok(was.getService(Service.MotionSensor) && !was.getService(Service.StatelessProgrammableSwitch), 'a button can become a sensor');
  assert.deepEqual(second.problems(), []);
});

test('a damaged or hand-edited config never crashes: bad entries are skipped with a warning', async (t) => {
  const { plex, plexTv, server } = await startPlex(t);
  for (const config of [
    { servers: 'nope', sensors: 'nope', timing: 'fast', webhook: 7, commands: [], devices: {}, selection: [] },
    { servers: [server, server, { id: 'x' }, { id: 'y', url: 'ftp://plex' }, null], devices: [null, { id: 'd' }], sensors: [null, 3, {}, { id: 'a' }, sensor('ok', 'playing', { filters: { devices: ['gone'], players: 'x', users: null } }), sensor('ok', 'idle'), sensor('s', 'sideways'), { id: 'b', name: 'Button', type: 'button', events: ['nope'] }, { id: 'e', name: '🎬', type: 'occupancy' }] },
    { servers: [server], timing: { pauseDebounce: -5, stopHold: 1e9, fallbackPercent: 'x', creditsOffset: null, midCredits: 'sideways', safetyResync: -1 }, webhook: { port: 'abc', advertisedUrl: 5 }, sensors: [] },
    {},
  ]) {
    const home = await startHome(t, { plexTv, config });
    await sleep(250);
    // A bad port falls back to the default one, which something else on this machine may hold.
    assert.deepEqual(home.problems().filter((line) => !/port 32550 is in use/.test(line)), [], JSON.stringify(config).slice(0, 80));
    await home.shutdown();
  }
  const home = await startHome(t, { plexTv, config: { servers: [server], sensors: [sensor('ok', 'playing', { name: 'Kept', filters: { devices: ['gone'] } })] } });
  await home.waitLog(/Watching/);
  await plex.play(tv, 'movie');
  await sleep(300);
  assert.deepEqual(home.active(), [], 'a sensor on a device that no longer exists matches nothing, not everything');
});

test('intros: the Intro sensor follows the intro marker, and Playing can leave it out', async (t) => {
  const { plex, plexTv, server } = await startPlex(t);
  plex.items.get('episode').Marker.unshift({ type: 'intro', startTimeOffset: 1_000, endTimeOffset: 1_600 });
  const sensors = [sensor('intro', 'intro', { name: 'Intro' }), sensor('playing', 'playing', { name: 'Playing', except: ['intro'] })];
  const home = await startHome(t, { plexTv, config: { servers: [server], sensors } });
  await home.waitActive([]);
  await plex.play(tv, 'episode', { offset: 0 });
  await home.waitActive(['Playing']);
  await home.waitActive(['Intro'], 3_000);
  await home.waitActive(['Playing'], 3_000);
  await plex.stop_(tv);
  await home.waitActive([]);
  assert.deepEqual(home.problems(), []);
});

test('music: the next track keeps Playing on, and a short pause changes nothing', async (t) => {
  const { plex, plexTv, server } = await startPlex(t);
  plex.items.set('song2', { title: 'Song 2', type: 'track', duration: 180_000, section: '4' });
  const home = await startHome(t, { plexTv, config: { servers: [server], timing: { pauseDebounce: 1, stopHold: 2 }, sensors: everyState() } });
  await home.waitActive(['Nothing Playing']);
  const seen = new Set();
  const watch = setInterval(() => home.active().forEach((name) => seen.add(name)), 5);
  t.after(() => clearInterval(watch));
  await plex.play(tv, 'song', { offset: 178_000 });
  await home.waitActive(['Media Playing']);
  seen.clear();
  await plex.stop_(tv);
  await plex.play(tv, 'song2');
  await sleep(400);
  await plex.pause(tv);
  await sleep(300);
  await plex.resume(tv);
  await sleep(1_500);
  assert.deepEqual([...seen], ['Media Playing']);
  assert.deepEqual(home.problems(), []);
});

test('a session Plex does not list yet is looked up again, then adopted', async (t) => {
  const { plex, plexTv, server } = await startPlex(t);
  const home = await startHome(t, { plexTv, config: { servers: [server], sensors: playingOn({ users: ['Steve'] }) } });
  await home.waitLog(/Playback read from Plex/);
  plex.hideSessions = true;
  await plex.play(tv, 'movie');
  await sleep(300);
  plex.hideSessions = false;
  await home.waitActive(['Media On'], 4_000);
  assert.deepEqual(home.problems(), []);
});

test('trailers and extras count for sensors on video libraries, not for music-only ones', async (t) => {
  const { plex, plexTv, server } = await startPlex(t);
  plex.items.set('trailer', { title: 'One Night Only', type: 'clip', duration: 142_000 });
  const sensors = [
    sensor('movies', 'active', { name: 'Movies On', filters: { libraries: [`${server.id}/1`] } }),
    sensor('music', 'active', { name: 'Music On', filters: { libraries: [`${server.id}/4`] } }),
    sensor('all', 'active', { name: 'Anything On' }),
  ];
  const home = await startHome(t, { plexTv, config: { servers: [server], sensors } });
  await home.waitLog(/Playback read from Plex/);
  await plex.play(tv, 'trailer');
  await home.waitActive(['Anything On', 'Movies On']);
  await sleep(200);
  assert.deepEqual(home.active(), ['Anything On', 'Movies On']);
  await plex.stop_(tv);
  await home.waitActive([]);
  assert.deepEqual(home.problems(), []);
});

test('trailers and extras turned off in Settings: they count for no sensor, but movies still do', async (t) => {
  const { plex, plexTv, server } = await startPlex(t);
  plex.items.set('trailer', { title: 'One Night Only', type: 'clip', duration: 142_000 });
  const sensors = [
    sensor('movies', 'active', { name: 'Movies On', filters: { libraries: [`${server.id}/1`] } }),
    sensor('all', 'active', { name: 'Anything On' }),
  ];
  const home = await startHome(t, { plexTv, config: { servers: [server], extras: false, sensors } });
  await home.waitLog(/Playback read from Plex/);
  assert.ok(home.logged(/trailers and extras off/), 'the start-up line says so');
  await plex.play(tv, 'trailer');
  await sleep(400);
  assert.deepEqual(home.active(), []);
  await plex.stop_(tv);
  await plex.play(tv, 'movie');
  await home.waitActive(['Anything On', 'Movies On']);
  assert.deepEqual(home.problems(), []);
});

test('response time: play, pause, resume and stop reach the sensors without waiting for anything slow', async (t) => {
  const { plex, plexTv, server } = await startPlex(t);
  plex.metadataDelayMs = 800;
  const port = await freePort();
  plex.webhookUrl = `http://127.0.0.1:${port}/secret0123456789`;
  const home = await startHome(t, { plexTv, config: { servers: [server], webhook: { port }, timing: { pauseDebounce: 1.5, stopHold: 10 }, sensors: everyState() } });
  await home.waitActive(['Nothing Playing']);
  const timed = async (action, want) => {
    const started = Date.now();
    await action();
    await home.waitActive(want);
    return Date.now() - started;
  };
  // With Plex Pass the webhook brings everything needed; the slow marker read is not waited for.
  const play = await timed(() => plex.play(tv, 'movie', { offset: 60_000 }), ['Media Playing']);
  assert.ok(play < 150, `play took ${play} ms`);
  const pause = await timed(() => plex.pause(tv), ['Media Paused']);
  assert.ok(pause >= 1_500 && pause < 1_700, `pause took ${pause} ms (the pause debounce is 1.5 s)`);
  const resume = await timed(() => plex.resume(tv), ['Media Playing']);
  assert.ok(resume < 100, `resume took ${resume} ms`);
  plex.seek(tv, 120_000);
  const stop = await timed(() => plex.stop_(tv), ['Nothing Playing']);
  assert.ok(stop >= 250 && stop < 400, `a stop partway through took ${stop} ms`);

  // Without the webhook, the session is read from the server first.
  plex.webhookUrl = undefined;
  const bare = await timed(() => plex.play(phone, 'episode', { offset: 0 }), ['Media Playing']);
  assert.ok(bare < 200, `play from the notification alone took ${bare} ms`);
  t.diagnostic(`play ${play} ms, pause ${pause} ms, resume ${resume} ms, stop ${stop} ms, play without webhook ${bare} ms`);
  assert.deepEqual(home.problems(), []);
});
