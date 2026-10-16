import assert from 'node:assert/strict';
import test from 'node:test';

import { parseConfig } from '../dist/config.js';
import {
  defaultSelection, movieNight, needsPlexPass, newSensor, setTiming, summarize, TIMING_FIELDS, timingValue,
} from '../homebridge-ui/public/model.js';
import { silentLog } from './helpers.js';

const discovery = {
  players: [
    { id: 'ATV', name: 'Living Room', product: 'Plex for Apple TV', plays: 40, playingNow: false },
    { id: 'PHONE', name: 'iPhone', plays: 2, playingNow: false },
  ],
  users: [{ id: '1', name: 'steve' }],
  libraries: [
    { id: '1', title: 'Movies', type: 'movie' },
    { id: '2', title: 'TV Shows', type: 'show' },
    { id: '3', title: 'Music', type: 'artist' },
  ],
};

test('setup preselects the most used player and the Movies and TV libraries', () => {
  const selection = defaultSelection(discovery);
  assert.deepEqual(selection.players.map((p) => p.id), ['ATV']);
  assert.deepEqual(selection.libraries.map((l) => l.id), ['1', '2']);
  assert.deepEqual(selection.users, []);
  const live = defaultSelection({ ...discovery, players: [discovery.players[0], { ...discovery.players[1], playingNow: true }] });
  assert.deepEqual(live.players.map((p) => p.id), ['PHONE'], 'a player that is playing now wins');
});

test('Movie Night produces sensors the plugin accepts', () => {
  const sensors = movieNight(defaultSelection(discovery));
  const warnings = [];
  const config = parseConfig({ sensors }, { ...silentLog, warn: (...args) => warnings.push(args) });
  assert.equal(warnings.length, 0);
  assert.deepEqual(config.sensors.map((s) => s.name), ['Movie Playing', 'Movie Started', 'Movie Paused', 'Credits Rolling', 'Movie Stopped']);
  assert.equal(new Set(config.sensors.map((s) => s.id)).size, 5);
  assert.deepEqual(config.sensors[0].filters, { players: ['ATV'], users: [], libraries: ['1', '2'], mediaTypes: [] });
  assert.deepEqual(config.sensors[3].events, ['credits.start']);
});

test('new sensors are valid', () => {
  for (const type of ['occupancy', 'motion', 'contact', 'button']) {
    const sensor = newSensor(type);
    assert.equal(parseConfig({ sensors: [sensor] }, silentLog).sensors.length, 1, type);
  }
});

test('summaries read as a sentence', () => {
  const selection = defaultSelection(discovery);
  const [playing, , , credits] = movieNight(selection);
  assert.equal(summarize(playing, selection), 'On while playing, before the credits, on Living Room, for Movies or TV Shows, by anyone.');
  assert.equal(summarize({ ...credits, filters: { players: [], users: ['steve'], libraries: [], mediaTypes: ['movie'] } }, selection),
    'Pressed when the credits start, on any player, for Movies, by steve.');
  assert.equal(needsPlexPass({ type: 'button', events: ['library.new'] }), true);
  assert.equal(needsPlexPass({ type: 'button', events: ['library.new', 'play'] }), false);
});

test('advanced fields round-trip through the config ranges', () => {
  const field = (key) => TIMING_FIELDS.find((f) => f.key === key);
  let timing = setTiming({}, field('minItemLength'), 5);
  assert.equal(timing.minItemLength, 300, 'minutes are stored as seconds');
  assert.equal(timingValue(timing, field('minItemLength')), 5);
  timing = setTiming(timing, field('safetyResync'), 0);
  timing = setTiming(timing, field('stopHold'), 999);
  timing = setTiming(timing, field('pauseDebounce'), 2);
  assert.deepEqual(timing, { minItemLength: 300, safetyResync: 0, stopHold: 60 }, 'defaults are left out, values clamped');
  const config = parseConfig({ timing }, silentLog);
  assert.equal(config.engine.minItemLengthMs, 300_000);
  assert.equal(config.engine.stopHoldMs, 60_000);
  assert.equal(config.safetyResyncMs, 0);
  for (const f of TIMING_FIELDS) {
    assert.equal(timingValue({}, f), f.default);
  }
});
