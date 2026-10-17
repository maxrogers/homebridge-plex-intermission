import assert from 'node:assert/strict';
import test from 'node:test';

import { parseConfig } from '../dist/config.js';
import {
  availableMediaTypes, defaultSelection, needsPlexPass, PRESETS, presetSensors, newSensor, setTiming, summarize, TIMING_FIELDS, timingValue,
} from '../homebridge-ui/public/model.js';
import { silentLog } from './helpers.js';

const discovery = {
  players: [
    { id: 'ATV', name: 'Living Room', product: 'Plex for Apple TV', plays: 40, playingNow: false },
    { id: 'PHONE', name: 'iPhone', plays: 2, playingNow: false },
  ],
  users: [{ id: '1', name: 'Steve', admin: true, managed: false }],
  servers: [
    {
      id: 'a', name: 'Unraid', libraries: [
        { id: '1', key: 'a/1', title: 'Movies', type: 'movie', kind: 'movie' },
        { id: '2', key: 'a/2', title: 'TV Shows', type: 'show', kind: 'show' },
        { id: '3', key: 'a/3', title: 'Music', type: 'artist', kind: 'music' },
        { id: '4', key: 'a/4', title: 'Home Videos', type: 'movie', kind: 'other' },
      ],
    },
    { id: 'b', name: 'Cabin', libraries: [{ id: '1', key: 'b/1', title: 'Kids Movies', type: 'movie', kind: 'movie' }] },
  ],
};

test('setup preselects the most used player and the Movies and TV libraries', () => {
  const selection = defaultSelection(discovery);
  assert.deepEqual(selection.players.map((p) => p.id), ['ATV']);
  assert.deepEqual(selection.libraries.map((l) => l.key), ['a/1', 'a/2', 'b/1'], 'movie and TV libraries on every server, not music or other videos');
  assert.equal(selection.allUsers, true);
  assert.deepEqual(selection.users, []);
  const live = defaultSelection({ ...discovery, players: [discovery.players[0], { ...discovery.players[1], playingNow: true }] });
  assert.deepEqual(live.players.map((p) => p.id), ['PHONE'], 'a player that is playing now wins');
});

test('Every State produces sensors the plugin accepts', () => {
  const sensors = presetSensors('states', defaultSelection(discovery));
  const warnings = [];
  const config = parseConfig({ sensors }, { ...silentLog, warn: (...args) => warnings.push(args) });
  assert.equal(warnings.length, 0);
  assert.deepEqual(config.sensors.map((s) => s.name), ['Media Playing', 'Media Paused', 'Credits Rolling', 'Nothing Playing']);
  assert.deepEqual(config.sensors.map((s) => `${s.type}:${s.state}`), ['occupancy:playing', 'occupancy:paused', 'occupancy:credits', 'occupancy:idle'], 'all state sensors');
  assert.equal(new Set(config.sensors.map((s) => s.id)).size, 4);
  assert.deepEqual(config.sensors[0].filters, { players: ['ATV'], users: [], libraries: ['a/1', 'a/2', 'b/1'], mediaTypes: [] });
  const some = presetSensors('states', { ...defaultSelection(discovery), allUsers: false, users: ['Steve'] });
  assert.deepEqual(some[0].filters.users, ['Steve']);
  const everything = presetSensors('states', { ...defaultSelection(discovery), allPlayers: true, allLibraries: true });
  assert.deepEqual(everything[0].filters, { players: [], users: [], libraries: [], mediaTypes: [] }, 'All means no filter');
});

test('new sensors are valid', () => {
  for (const type of ['occupancy', 'motion', 'contact', 'button']) {
    const sensor = newSensor(type);
    assert.equal(parseConfig({ sensors: [sensor] }, silentLog).sensors.length, 1, type);
  }
});

test('summaries read as a sentence', () => {
  const selection = defaultSelection(discovery);
  const [playing, , credits] = presetSensors('states', selection);
  assert.equal(summarize(playing, selection), 'On while playing, before the credits, on Living Room, for Movies, TV Shows or 1 more, by anyone.');
  assert.equal(summarize({ ...credits, filters: { players: [], users: ['steve'], libraries: [], mediaTypes: ['movie'] } }, selection),
    'On while in the credits, on any player, for Movies and other videos, by steve.');
  assert.equal(summarize({ type: 'button', events: ['credits.start'], filters: { players: [], users: [], libraries: [], mediaTypes: [] } }, selection),
    'Pressed when the credits start, on any player, for anything, by anyone.');
  assert.equal(needsPlexPass({ type: 'button', events: ['library.new'] }), true);
  assert.equal(needsPlexPass({ type: 'button', events: ['library.new', 'play'] }), false);
});

test('media types follow the chosen libraries', () => {
  const libraries = discovery.servers[0].libraries;
  assert.deepEqual(availableMediaTypes(libraries.slice(0, 2)), ['movie', 'episode']);
  assert.deepEqual(availableMediaTypes(libraries), ['movie', 'episode', 'track']);
  assert.deepEqual(availableMediaTypes([{ kind: 'photo' }]), ['photo', 'clip']);
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

test('the single-sensor presets differ only in how they treat the credits', () => {
  assert.deepEqual(PRESETS.map((p) => p.id), ['simple', 'credits', 'states']);
  const simple = parseConfig({ sensors: presetSensors('simple', defaultSelection(discovery)) }, silentLog).sensors;
  const credits = parseConfig({ sensors: presetSensors('credits', defaultSelection(discovery)) }, silentLog).sensors;
  assert.deepEqual(simple.map((s) => s.state), ['playing-any']);
  assert.deepEqual(credits.map((s) => s.state), ['playing']);
  assert.equal(PRESETS.find((p) => p.recommended).id, 'credits');
});
