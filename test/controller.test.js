import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { parseConfig } from '../dist/config.js';
import { Controller } from '../dist/controller.js';
import { PlexHttpError } from '../dist/plex/server.js';
import { FakeClock, PLAYER, session, settle, silentLog } from './helpers.js';

class FakeStream extends EventEmitter {
  isConnected = false;
  start() {}
  stop() {}
  connect() {
    this.isConnected = true;
    this.emit('connected');
  }
  disconnect() {
    this.isConnected = false;
    this.emit('disconnected');
  }
}

class FakeWebhooks extends EventEmitter {}

const timeline = [];
class FakeSensor {
  presses = 0;
  active = undefined;
  constructor(config) {
    this.config = config;
  }
  setActive(active) {
    if (active !== this.active) timeline.push(`${this.config.name}=${active}`);
    this.active = active;
  }
  press() {
    this.presses++;
    timeline.push(`${this.config.name} pressed`);
  }
}

const SENSORS = [
  { id: 'playing', name: 'Movie Playing', type: 'occupancy', state: 'playing', except: ['credits'] },
  { id: 'credits', name: 'Credits Rolling', type: 'button', events: ['credits.start'] },
  { id: 'paused', name: 'Movie Paused', type: 'button', events: ['pause'] },
  { id: 'other-tv', name: 'Bedroom', type: 'occupancy', state: 'active', filters: { players: ['BEDROOM'] } },
  { id: 'new', name: 'New Movie', type: 'button', events: ['library.new'], filters: { libraries: ['server-1/1'] } },
  { id: 'idle', name: 'Nothing Playing', type: 'occupancy', state: 'idle' },
  { id: 'credits-state', name: 'In Credits', type: 'occupancy', state: 'credits' },
];

function setup({ playing = [], markers = [{ type: 'credits', startMs: 100_000, endMs: 120_000, final: true }], raw = {}, sensors: list = SENSORS, getFacts, players, sessionFor, log: logOverride } = {}) {
  const clock = new FakeClock();
  const stream = new FakeStream();
  const webhooks = new FakeWebhooks();
  const errors = [];
  const log = { ...silentLog, ...logOverride, error: (...args) => errors.push(args) };
  const config = parseConfig({ servers: [{ id: 'server-1', name: 'Plex', url: 'http://plex' }], sensors: list, ...raw }, silentLog);
  const sensors = config.sensors.map((sensor) => new FakeSensor(sensor));
  const server = {
    playing: async () => (typeof playing === 'function' ? playing() : playing),
    session: async (playerId) => (sessionFor ? sessionFor(playerId) : session()),
  };
  let unauthorized = 0;
  const controller = new Controller({
    config,
    server: config.servers[0],
    log,
    clock,
    plex: server,
    stream,
    webhooks,
    getMarkers: async () => markers,
    getFacts,
    sensors,
    onUnauthorized: () => unauthorized++,
    players,
  });
  const byId = Object.fromEntries(sensors.map((sensor) => [sensor.config.id, sensor]));
  return { clock, stream, webhooks, controller, sensors: byId, errors, unauthorized: () => unauthorized };
}

const notify = (state, viewOffset, extra = {}) => ({
  clientIdentifier: PLAYER, sessionKey: '7', ratingKey: '1', state, viewOffset, ...extra,
});

test('state sensors follow playback and buttons press on credits and pause', async () => {
  const { clock, stream, controller, sensors } = setup();
  await controller.start();
  stream.emit('playing', notify('playing', 90_000));
  await settle();
  assert.equal(sensors.playing.active, true);
  assert.equal(sensors['other-tv'].active, false, 'filtered to another player');

  await clock.advance(10_000);
  assert.equal(sensors.credits.presses, 1);
  assert.equal(sensors.playing.active, false, 'Playing (before credits) ends at the credits');

  stream.emit('playing', notify('paused', 101_000));
  await clock.advance(3_000);
  assert.equal(sensors.paused.presses, 1);
  await controller.stop();
});

test('webhook-only events press matching buttons, and other servers are ignored', async () => {
  const { webhooks, controller, sensors } = setup();
  await controller.start();
  const libraryNew = (serverId, section) => ({
    event: 'library.new', owner: true, Server: { uuid: serverId },
    Metadata: { ratingKey: '9', title: 'New', type: 'movie', librarySectionID: section },
  });
  webhooks.emit('payload', libraryNew('server-2', 1));
  webhooks.emit('payload', libraryNew('server-1', 2));
  assert.equal(sensors.new.presses, 0);
  webhooks.emit('payload', libraryNew('server-1', 1));
  assert.equal(sensors.new.presses, 1);
  await controller.stop();
});

test('connecting re-syncs: restores sessions and ends players Plex no longer lists', async () => {
  let live = [notify('playing', 10_000)];
  const { clock, stream, controller, sensors } = setup({ playing: () => live });
  await controller.start();
  stream.connect();
  await settle();
  await settle();
  assert.equal(sensors.playing.active, true, 'restored from /status/sessions');

  live = [];
  stream.disconnect();
  stream.connect();
  await settle();
  assert.equal(sensors.playing.active, true, 'a stop is held for autoplay');
  await clock.advance(10_000);
  assert.equal(controller.engine.snapshot(PLAYER).activity, 'idle');
  assert.equal(sensors.playing.active, false);
  await controller.stop();
});

test('re-syncs periodically only while disconnected and something plays', async () => {
  let reads = 0;
  const { clock, stream, controller } = setup({ playing: () => (reads++, [notify('playing', 10_000)]), raw: { timing: { safetyResync: 1 } } });
  await controller.start();
  stream.connect();
  await settle();
  assert.equal(reads, 1);
  stream.disconnect();
  await clock.advance(60_000);
  assert.equal(reads, 2);
  await clock.advance(60_000);
  assert.equal(reads, 3);
  stream.connect();
  await settle();
  await clock.advance(5 * 60_000);
  assert.equal(reads, 4, 'only the reconnect read; no timer while connected');
  await controller.stop();
});

test('a rejected sign-in is reported once', async () => {
  const { stream, controller, errors, unauthorized } = setup({
    playing: () => {
      throw new PlexHttpError(401, '/status/sessions');
    },
  });
  await controller.start();
  stream.connect();
  await settle();
  stream.disconnect();
  stream.connect();
  await settle();
  assert.equal(unauthorized(), 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0][0], /sign in again/);
  await controller.stop();
});

test('states keep their pre-restart value until Plex has been read', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { clock, stream, controller, sensors } = setup({ playing: async () => { await gate; return [notify('playing', 10_000)]; } });
  await controller.start();
  stream.connect();
  await settle();
  assert.equal(sensors.idle.active, undefined, 'nothing published while Plex has not answered');
  release();
  await settle(); await settle();
  assert.equal(sensors.playing.active, true);
  assert.equal(sensors.idle.active, false);
  await clock.advance(30_000);
  await controller.stop();
});

test('with nothing playing, Nothing Playing turns on after the first read', async () => {
  const { stream, controller, sensors } = setup({ playing: [] });
  await controller.start();
  stream.connect();
  await settle(); await settle();
  assert.equal(sensors.idle.active, true);
  assert.equal(sensors.playing.active, false);
  await controller.stop();
});

test('at the credits, states change before the button press, offs before ons', async () => {
  const { clock, stream, controller } = setup();
  await controller.start();
  stream.emit('playing', notify('playing', 95_000));
  await settle();
  timeline.length = 0;
  await clock.advance(6_000);
  assert.deepEqual(timeline, ['Movie Playing=false', 'In Credits=true', 'Credits Rolling pressed']);
  await controller.stop();
});

test('Every State through a movie with a mid-credits scene: exactly one sensor on at each moment', async () => {
  const markers = [
    { type: 'credits', startMs: 100_000, endMs: 160_000, final: false },
    { type: 'credits', startMs: 220_000, endMs: 400_000, final: true },
  ];
  const clock = new FakeClock();
  const stream = new FakeStream();
  const states = ['playing', 'paused', 'credits', 'idle'];
  const config = parseConfig({
    servers: [{ id: 'server-1', name: 'Plex', url: 'http://plex' }],
    sensors: states.map((state) => ({ id: state, name: state, type: 'occupancy', state, except: ['playing', 'paused'].includes(state) ? ['credits'] : [] })),
  }, silentLog);
  const sensors = config.sensors.map((sensor) => new FakeSensor(sensor));
  const controller = new Controller({
    config, server: config.servers[0], log: silentLog, clock, stream, webhooks: new FakeWebhooks(),
    plex: { playing: async () => [], session: async () => session() },
    getMarkers: async () => markers, sensors,
  });
  const on = () => sensors.filter((s) => s.active).map((s) => s.config.state).join('+');
  const seen = [];
  const at = async (ms) => { await clock.advanceTo(start + ms); seen.push(on()); };
  const start = clock.now();
  await controller.start();
  stream.connect();
  await settle(); await settle();
  seen.push(on()); // before playing
  stream.emit('playing', notify('playing', 90_000));
  await settle();
  await at(5_000); // 95 s: playing
  await at(15_000); // 105 s: first credits
  stream.emit('playing', notify('paused', 110_000)); // pause during the credits
  await at(25_000);
  stream.emit('playing', notify('playing', 110_000));
  await at(30_000); // 115 s: still credits
  await at(80_000); // 165 s: mid-credits scene
  stream.emit('playing', notify('paused', 170_000)); // pause during the scene
  await at(90_000);
  stream.emit('playing', notify('playing', 170_000));
  await at(95_000); // 175 s: scene
  await at(146_000); // 226 s: final credits
  stream.emit('playing', notify('stopped', 240_000));
  await at(160_000); // after the stop hold
  assert.deepEqual(seen, ['idle', 'playing', 'credits', 'credits', 'credits', 'playing', 'paused', 'playing', 'credits', 'idle']);
  await controller.stop();
});

test('media conditions: a sensor turns on once the item\'s details are read, and only when they match', async () => {
  let reads = 0;
  const { stream, controller, sensors } = setup({
    sensors: [
      { id: 'wide', name: 'Wide Playing', type: 'occupancy', state: 'playing', media: { shape: 'wide' } },
      { id: 'kids', name: 'Kids Playing', type: 'occupancy', state: 'playing', media: { ratings: ['G', 'PG'] } },
      { id: 'all', name: 'Media Playing', type: 'occupancy', state: 'playing' },
    ],
    getFacts: async () => {
      reads++;
      return { aspectRatio: 2.39, resolution: '4k', dynamicRange: 'hdr', contentRating: 'PG-13', labels: [] };
    },
  });
  await controller.start();
  stream.emit('playing', notify('playing', 10_000));
  await settle();
  assert.equal(sensors.all.active, true);
  assert.equal(sensors.wide.active, true, 'turned on after the details arrived');
  assert.equal(sensors.kids.active, false, 'PG-13 is not G or PG');
  stream.emit('playing', notify('playing', 20_000));
  await settle();
  assert.equal(reads, 1, 'details are read once per item');
  await controller.stop();
});

test('a chosen player that Plex gives a new ID is followed when its name, app and address match', async () => {
  const { PlayerBook } = await import('../dist/players.js');
  let saved;
  const storage = { readPlayers: async () => saved, writePlayers: async (value) => { saved = value; } };
  const book = new PlayerBook(storage);
  await book.load();
  const info = [];
  const warnings = [];
  const details = {
    OLD: { playerTitle: 'Apple TV', product: 'Plex for Apple TV', address: '10.0.0.20' },
    NEW: { playerTitle: 'Apple TV', product: 'Plex for Apple TV', address: '10.0.0.20' },
    INFUSE: { playerTitle: 'Apple TV', product: 'Infuse', address: '10.0.0.20' },
    BEDROOM: { playerTitle: 'Apple TV', product: 'Plex for Apple TV', address: '10.0.0.31' },
  };
  const { clock, stream, controller, sensors } = setup({
    sensors: [{ id: 'playing', name: 'Movie Playing', type: 'occupancy', state: 'playing', filters: { players: ['OLD'] } }],
    raw: { selection: { players: [{ id: 'OLD', name: 'Apple TV', product: 'Plex for Apple TV' }], dismissedPlayers: [] } },
    players: book,
    sessionFor: (playerId) => session({ playerId, ...details[playerId] }),
    log: { info: (...a) => info.push(a.join(' ')), warn: (...a) => warn(a) },
  });
  function warn(a) { warnings.push(a.join(' ')); }
  await controller.start();
  stream.connect();
  await settle();
  const play = async (id, key) => {
    stream.emit('playing', { clientIdentifier: id, sessionKey: key, ratingKey: '1', state: 'playing', viewOffset: 1_000 });
    for (let i = 0; i < 5; i++) await settle();
  };
  const stop = async (id, key) => {
    stream.emit('playing', { clientIdentifier: id, sessionKey: key, ratingKey: '1', state: 'stopped', viewOffset: 1_000 });
    await clock.advance(30_000);
  };

  await play('OLD', '1');
  assert.equal(sensors.playing.active, true);
  assert.equal(book.get('OLD').address, '10.0.0.20', 'the chosen player is learned as it plays');
  await stop('OLD', '1');

  await play('INFUSE', '2');
  assert.equal(sensors.playing.active, false, 'another app on the same Apple TV is not followed');
  assert.equal(warnings.length, 0, 'a different app is not pointed out');
  await stop('INFUSE', '2');

  await play('BEDROOM', '3');
  assert.equal(sensors.playing.active, false, 'the same app on another address is not followed');
  assert.match(warnings[0], /no sensor watches it/);
  await stop('BEDROOM', '3');

  await play('NEW', '4');
  assert.equal(sensors.playing.active, true, 'the reinstalled app is followed');
  assert.ok(info.some((line) => /has a new Plex ID/.test(line)));
  assert.deepEqual(saved.followed, { NEW: ['OLD'] }, 'kept across restarts');
  await book.flush();
});

test('player records survive bad files and forget players unseen for 90 days', async () => {
  const { PlayerBook, parseRecords } = await import('../dist/players.js');
  const empty = { seen: {}, followed: {}, sightings: {}, sharedNames: {} };
  assert.deepEqual(parseRecords('junk'), empty);
  assert.deepEqual(parseRecords({ seen: { A: { name: 1 } }, followed: { B: 'x' } }), empty);
  const old = { seen: { A: { lastPlayedAt: '2026-01-01T00:00:00Z' }, B: { lastPlayedAt: '2026-11-01T00:00:00Z' } }, followed: { A: ['X'] } };
  const book = new PlayerBook({ readPlayers: async () => old, writePlayers: async () => {} });
  await book.load(new Date('2026-11-06T00:00:00Z'));
  assert.equal(book.get('A'), undefined);
  assert.deepEqual(book.followedAs('A'), []);
  assert.ok(book.get('B'));
});

test('a device follows every app reporting its name at home, except apps left out', async () => {
  const details = {
    PLEX: { playerTitle: 'Apple TV', product: 'Plex for Apple TV', platform: 'tvOS', address: '10.0.0.20', local: true },
    INFUSE: { playerTitle: 'Apple TV', product: 'Infuse', platform: 'tvOS', address: '10.0.0.20', local: true },
    KIDS: { playerTitle: 'Apple TV', product: 'Kids App', platform: 'tvOS', address: '10.0.0.20', local: true },
    BRIDGED: { playerTitle: 'Apple TV', product: 'Plex for Apple TV', platform: 'tvOS', address: '192.168.1.40', local: false },
    AWAY: { playerTitle: 'Apple TV', product: 'Plex for Apple TV', platform: 'tvOS', address: '73.14.2.9', local: false },
    PHONE: { playerTitle: 'iPhone', product: 'Plex for iOS', platform: 'iOS', address: '10.0.0.30', local: true },
  };
  const { clock, stream, controller, sensors } = setup({
    sensors: [{ id: 'playing', name: 'Movie Playing', type: 'occupancy', state: 'playing', filters: { devices: ['d-1'], exceptPlayers: ['KIDS'] } }],
    raw: { devices: [{ id: 'd-1', name: 'Living Room', match: 'apple tv' }] },
    sessionFor: (playerId) => session({ playerId, ...details[playerId] }),
  });
  await controller.start();
  stream.connect();
  await settle();
  const check = async (id, want, why) => {
    stream.emit('playing', { clientIdentifier: id, sessionKey: id, ratingKey: '1', state: 'playing', viewOffset: 1_000 });
    for (let i = 0; i < 5; i++) await settle();
    assert.equal(sensors.playing.active, want, `${id}: ${why}`);
    stream.emit('playing', { clientIdentifier: id, sessionKey: id, ratingKey: '1', state: 'stopped', viewOffset: 1_000 });
    await clock.advance(30_000);
  };
  await check('PLEX', true, 'the Plex app on the device');
  await check('INFUSE', true, 'another app on the device, never chosen by ID');
  await check('KIDS', false, 'an app left out');
  await check('BRIDGED', true, 'a private address counts as home even when Plex says remote');
  await check('AWAY', false, 'a same-named device outside the home');
  await check('PHONE', false, 'another device');
});

test('a device narrowed to its apps takes a new app at the same address; a name seen at two addresses in turn is shared', async () => {
  const { PlayerBook } = await import('../dist/players.js');
  let saved;
  const book = new PlayerBook({ readPlayers: async () => saved, writePlayers: async (value) => { saved = value; } });
  await book.load();
  const warnings = [];
  const at = (address) => ({ playerTitle: 'Apple TV', platform: 'tvOS', address, local: true });
  const details = {
    PLEX: { ...at('10.0.0.20'), product: 'Plex for Apple TV' },
    VIDHUB: { ...at('10.0.0.20'), product: 'VidHub' },
    BEDROOM: { ...at('10.0.0.31'), product: 'Plex for Apple TV' },
    PLEX2: { ...at('10.0.0.20'), product: 'Plex for Apple TV' },
  };
  const { clock, stream, controller, sensors } = setup({
    sensors: [{ id: 'playing', name: 'Movie Playing', type: 'occupancy', state: 'playing', filters: { devices: ['d-1'] } }],
    raw: { devices: [{ id: 'd-1', name: 'Living Room', match: 'Apple TV', apps: ['PLEX'] }] },
    players: book,
    sessionFor: (playerId) => session({ playerId, ...details[playerId] }),
    log: { warn: (...a) => warnings.push(a.join(' ')) },
  });
  await controller.start();
  stream.connect();
  await settle();
  const play = async (id, want, why) => {
    stream.emit('playing', { clientIdentifier: id, sessionKey: id, ratingKey: '1', state: 'playing', viewOffset: 1_000 });
    for (let i = 0; i < 6; i++) await settle();
    assert.equal(sensors.playing.active, want, `${id}: ${why}`);
    stream.emit('playing', { clientIdentifier: id, sessionKey: id, ratingKey: '1', state: 'stopped', viewOffset: 1_000 });
    await clock.advance(30_000);
  };
  await play('PLEX', true, 'a pinned app');
  await play('VIDHUB', true, 'a new app at the pinned app\'s address joins the device');
  await play('BEDROOM', false, 'the other Apple TV');
  assert.equal(book.isShared('Apple TV'), false, 'one move could be an address change');
  await play('PLEX2', true, 'a reinstalled app back at the first address');
  assert.equal(book.isShared('apple tv'), true, 'back at the first address: two devices');
  assert.deepEqual(book.followedAs('VIDHUB'), ['PLEX']);
});

test('addresses shared by players on different platforms are not trusted', async () => {
  const { PlayerBook } = await import('../dist/players.js');
  const book = new PlayerBook({ readPlayers: async () => undefined, writePlayers: async () => {} });
  await book.load();
  const media = session().media;
  book.record({ playerId: 'TV', playerTitle: 'Apple TV', platform: 'tvOS', address: '172.17.0.1', media }, new Set());
  assert.equal(book.trusted('172.17.0.1'), true);
  book.record({ playerId: 'PHONE', playerTitle: 'iPhone', platform: 'iOS', address: '172.17.0.1', media }, new Set());
  assert.equal(book.trusted('172.17.0.1'), false);
  const { followed } = book.record({ playerId: 'TV2', playerTitle: 'Apple TV', platform: 'tvOS', product: 'X', address: '172.17.0.1', media }, new Set(['TV']), { pinned: new Set(['TV']) });
  assert.deepEqual(followed, [], 'nothing is followed by an untrusted address');
});
