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

class FakeWebhooks extends EventEmitter {
  async start() {}
  async stop() {}
}

class FakeSensor {
  presses = 0;
  active = false;
  constructor(config) {
    this.config = config;
  }
  setActive(active) {
    this.active = active;
  }
  press() {
    this.presses++;
  }
}

const SENSORS = [
  { id: 'playing', name: 'Movie Playing', type: 'occupancy', state: 'playing' },
  { id: 'credits', name: 'Credits Rolling', type: 'button', events: ['credits.start'] },
  { id: 'paused', name: 'Movie Paused', type: 'button', events: ['pause'] },
  { id: 'other-tv', name: 'Bedroom', type: 'occupancy', state: 'active', filters: { players: ['BEDROOM'] } },
  { id: 'new', name: 'New Movie', type: 'button', events: ['library.new'], filters: { libraries: ['1'] } },
];

function setup({ playing = [], markers = [{ type: 'credits', startMs: 100_000, endMs: 120_000, final: true }], raw = {} } = {}) {
  const clock = new FakeClock();
  const stream = new FakeStream();
  const webhooks = new FakeWebhooks();
  const errors = [];
  const log = { ...silentLog, error: (...args) => errors.push(args) };
  const config = parseConfig({ server: { id: 'server-1', url: 'http://plex' }, sensors: SENSORS, ...raw }, silentLog);
  const sensors = config.sensors.map((sensor) => new FakeSensor(sensor));
  const server = {
    playing: async () => (typeof playing === 'function' ? playing() : playing),
    session: async () => session(),
  };
  let unauthorized = 0;
  const controller = new Controller({
    config,
    log,
    clock,
    server,
    stream,
    webhooks,
    getMarkers: async () => markers,
    sensors,
    onUnauthorized: () => unauthorized++,
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
