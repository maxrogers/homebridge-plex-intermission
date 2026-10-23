import assert from 'node:assert/strict';
import test from 'node:test';

import { parseConfig } from '../dist/config.js';
import {
  defaultSelection, followSelection, missingSetupPlayers, needsPlexPass, playerLabel, PRESETS, presetSensors, presetsInUse, newSensor, setTiming, summarize, TIMING_FIELDS, timingValue,
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
  assert.deepEqual(config.sensors.map((s) => `${s.type}:${s.state}:${s.except.join()}`), ['occupancy:playing:credits', 'occupancy:paused:credits', 'occupancy:credits:', 'occupancy:idle:'], 'all state sensors');
  assert.equal(new Set(config.sensors.map((s) => s.id)).size, 4);
  assert.deepEqual(config.sensors[0].filters, { players: ['ATV'], users: [], libraries: ['a/1', 'a/2', 'b/1'] });
  const some = presetSensors('states', { ...defaultSelection(discovery), allUsers: false, users: ['Steve'] });
  assert.deepEqual(some[0].filters.users, ['Steve']);
  const everything = presetSensors('states', { ...defaultSelection(discovery), allPlayers: true, allLibraries: true });
  assert.deepEqual(everything[0].filters, { players: [], users: [], libraries: [] }, 'All means no filter');
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
  assert.equal(summarize(playing, selection), 'On while playing, except during the credits, on Living Room, for Movies, TV Shows or 1 more, by anyone.');
  assert.equal(summarize({ ...credits, filters: { players: [], users: ['steve'], libraries: [] } }, selection),
    'On while in the credits, on any player, for anything, by steve.');
  assert.equal(summarize({ type: 'button', events: ['credits.start'], filters: { players: [], users: [], libraries: [] } }, selection),
    'Pressed when the credits start, on any player, for anything, by anyone.');
  assert.equal(needsPlexPass({ type: 'button', events: ['library.new'] }), true);
  assert.equal(needsPlexPass({ type: 'button', events: ['library.new', 'play'] }), false);
});

test('new sensors start from the setup choices', () => {
  const selection = defaultSelection(discovery);
  const sensor = newSensor('occupancy', selection);
  assert.deepEqual(sensor.filters, { players: selection.players.map((p) => p.id), users: [], libraries: selection.libraries.map((l) => l.key) });
  assert.deepEqual(newSensor('button', { ...selection, allPlayers: true, allLibraries: true }).filters, { players: [], users: [], libraries: [] });
  assert.deepEqual(newSensor('occupancy').filters, { players: [], users: [], libraries: [] }, 'no selection: everything');
});

test('advanced fields round-trip through the config ranges', () => {
  const field = (key) => TIMING_FIELDS.find((f) => f.key === key);
  let timing = setTiming({}, field('minItemLength'), 5);
  assert.equal(timing.minItemLength, 300, 'minutes are stored as seconds');
  assert.equal(timingValue(timing, field('minItemLength')), 5);
  timing = setTiming(timing, field('safetyResync'), 0);
  timing = setTiming(timing, field('stopHold'), 999);
  timing = setTiming(timing, field('pauseDebounce'), 1.5);
  assert.deepEqual(timing, { minItemLength: 300, safetyResync: 0, stopHold: 60 }, 'defaults are left out, values clamped');
  assert.equal(setTiming({}, field('pauseDebounce'), 2.2).pauseDebounce, 2, 'half-second steps');
  assert.equal(setTiming({}, field('pauseDebounce'), 0.7).pauseDebounce, 0.5);
  assert.equal(setTiming({}, field('pauseDebounce'), 1.3).pauseDebounce, undefined, '1.3 rounds to the default');
  assert.equal(setTiming({}, field('stopHold'), 12.4).stopHold, 12, 'whole seconds');
  assert.equal(setTiming({ stopHold: 20 }, field('stopHold'), '').stopHold, undefined, 'a cleared field goes back to the default, not 0');
  assert.equal(setTiming({}, field('safetyResync'), '0').safetyResync, 0, 'a typed 0 is kept');
  assert.equal(parseConfig({ timing: { pauseDebounce: 0.5 } }, silentLog).engine.pauseDebounceMs, 500);
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
  assert.deepEqual(simple.map((s) => `${s.state}:${s.except.join()}`), ['playing:']);
  assert.deepEqual(credits.map((s) => `${s.state}:${s.except.join()}`), ['playing:credits']);
  assert.equal(PRESETS.find((p) => p.recommended).id, 'credits');
});

test('changing servers keeps choices and sensors consistent', async () => {
  const { reconcileSelection, reconcileSensors, libraryRef } = await import('../homebridge-ui/public/model.js');
  const lib = (server, id, title, kind) => ({ id, key: `${server}/${id}`, title, type: kind === 'show' ? 'show' : 'movie', kind });
  const serverA = { id: 'a', name: 'Unraid', libraries: [lib('a', '1', 'Movies', 'movie'), lib('a', '2', 'TV', 'show'), lib('a', '3', 'Music', 'music')] };
  const serverB = { id: 'b', name: 'Cabin', libraries: [lib('b', '1', 'Kids Movies', 'movie'), lib('b', '4', 'Tunes', 'music')] };
  const both = { players: [], users: [], servers: [serverA, serverB] };
  const onlyA = { players: [], users: [], servers: [serverA] };
  const onlyB = { players: [], users: [], servers: [serverB] };

  // First setup with both servers: Movies and TV on both are chosen.
  const first = defaultSelection(both);
  assert.deepEqual(first.libraries.map((l) => l.key), ['a/1', 'a/2', 'b/1']);

  // Dropping Cabin removes its libraries from the choices.
  const dropped = reconcileSelection(first, onlyA, ['a', 'b']);
  assert.deepEqual(dropped.libraries.map((l) => l.key), ['a/1', 'a/2']);

  // Adding Cabin back chooses its Movies and TV, and keeps a manual choice on Unraid.
  const manual = { ...dropped, libraries: [...dropped.libraries, libraryRef(serverA, serverA.libraries[2])] };
  const readded = reconcileSelection(manual, both, ['a']);
  assert.deepEqual(readded.libraries.map((l) => l.key), ['a/1', 'a/2', 'a/3', 'b/1']);

  // "All libraries" stays all.
  assert.deepEqual(reconcileSelection({ ...first, allLibraries: true }, onlyA, ['a', 'b']).libraries, []);

  const known = [...serverA.libraries, ...serverB.libraries].map((l) => ({ key: l.key, kind: l.kind }));
  const sensors = [
    { id: 'tv', filters: { libraries: ['a/1', 'a/2'] } },
    { id: 'music', filters: { libraries: ['a/3'] } },
    { id: 'all', filters: { libraries: [] } },
    { id: 'cabin', filters: { libraries: ['b/1'] } },
  ];
  // Adding Cabin: each sensor gains Cabin's libraries of the kinds it already uses.
  const grown = reconcileSensors(sensors, both, ['a'], known);
  assert.deepEqual(grown.map((s) => s.filters.libraries), [['a/1', 'a/2', 'b/1'], ['a/3', 'b/4'], [], ['b/1']]);
  // Removing Cabin: its libraries go; a sensor that only used Cabin gets Unraid's libraries of the same kind, never "all".
  const shrunk = reconcileSensors(grown, onlyA, ['a', 'b'], known);
  assert.deepEqual(shrunk.map((s) => s.filters.libraries), [['a/1', 'a/2'], ['a/3'], [], ['a/1']]);
  // Switching entirely to Cabin: a TV-only sensor has no TV there, so it falls back to Movies and TV.
  const switched = reconcileSensors([{ id: 'x', filters: { libraries: ['a/2'] } }], onlyB, ['a'], known);
  assert.deepEqual(switched[0].filters.libraries, ['b/1']);
});

test('adding a preset alongside or in place of existing sensors', async () => {
  const { applyPreset, groupIntact } = await import('../homebridge-ui/public/model.js');
  const selection = { allPlayers: true, players: [], allUsers: true, users: [], allLibraries: true, libraries: [] };
  const mine = [
    { id: 's-mine', name: 'Media Playing', type: 'occupancy', state: 'playing', except: [], filters: { players: ['ATV'], users: [], libraries: [] }, run: { on: ['c-1'], off: [], press: [] } },
    { id: 's-other', name: 'Projector', type: 'occupancy', state: 'playing', except: [], filters: { players: [], users: [], libraries: [] } },
  ];

  const along = applyPreset(mine, 'states', selection, 'alongside');
  assert.equal(along.length, 6);
  assert.deepEqual(along.slice(2).map((s) => s.name), ['Media Playing 2', 'Media Paused', 'Credits Rolling', 'Nothing Playing'], 'clashing names get a number');
  const group = along[2].group;
  assert.match(group, /^states:/);
  assert.ok(along.slice(2).every((s) => s.group === group), 'Every State is one group');
  assert.equal(groupIntact(along.slice(2)), true);

  const replaced = applyPreset(mine, 'states', selection, 'replace');
  assert.equal(replaced.length, 4, 'the old sensors are gone');
  assert.equal(replaced[0].id, 's-mine', 'same name keeps the sensor (and its Home automations)');
  assert.deepEqual(replaced[0].run.on, ['c-1']);
  assert.deepEqual(replaced[0].except, ['credits'], 'but it now works as the preset says');
  assert.equal(groupIntact(replaced), false, 'its own players differ from the rest, so the set may overlap');

  const edited = along.slice(2).map((s, i) => (i === 1 ? { ...s, except: [] } : s));
  assert.equal(groupIntact(edited), false);
  assert.equal(groupIntact(along.slice(2, 5)), false, 'a member removed');

  const single = applyPreset([], 'credits', selection);
  assert.equal(single.length, 1);
  assert.equal(single[0].group, undefined, 'single-sensor presets are not grouped');
});

test('media conditions read as part of the summary', async () => {
  const { summarize, describeFacts } = await import('../homebridge-ui/public/model.js');
  const sensor = { name: 'Wide', type: 'occupancy', state: 'playing', except: [], filters: { players: [], users: [], libraries: [] }, media: { shape: 'wide', ratings: ['G', 'PG'] } };
  assert.equal(summarize(sensor), 'On while playing, on any player, for anything with a wide picture, rated G or PG, by anyone.');
  assert.deepEqual(describeFacts({ aspectRatio: 2.39, resolution: '4k', dynamicRange: 'dv', contentRating: 'PG-13', labels: ['Kids'] }),
    { shape: 'Wide 2.39:1', shapeValue: 'wide', resolution: '4K', dynamicRange: 'Dolby Vision', rating: 'PG-13', labels: ['Kids'] });
});

test('presets in use are recognised from the sensors', () => {
  const group = 'states:ab12';
  const states = presetSensors('states', defaultSelection(discovery)).map((sensor) => ({ ...sensor, group }));
  assert.deepEqual(presetsInUse([]), []);
  assert.deepEqual(presetsInUse(states), ['states']);
  assert.deepEqual(presetsInUse(presetSensors('credits', defaultSelection(discovery))), ['credits']);
  assert.deepEqual(presetsInUse([...presetSensors('simple', defaultSelection(discovery)), ...states]), ['simple', 'states'], 'in preset order');
  const custom = [
    { type: 'occupancy', state: 'playing', except: [], media: { shape: 'wide' } },
    { type: 'occupancy', state: 'paused', except: [] },
    { type: 'button', state: 'playing', events: ['media.play'] },
    { type: 'occupancy', state: 'playing', except: ['credits', 'intro'] },
  ];
  assert.deepEqual(presetsInUse(custom), [], 'media conditions, other states, buttons and extra exceptions are custom');
});

const twoApps = [
  { id: 'ATV-PLEX', name: 'Apple TV', product: 'Plex for Apple TV' },
  { id: '1AF4CEC1-CE71-4863-9574-1779931694B3', name: 'Apple TV', product: 'Infuse' },
  { id: 'IPAD', name: 'iPad', product: 'Plex for iOS' },
];

test('players with the same name are told apart by app, or by ID when the apps match', () => {
  assert.equal(playerLabel(twoApps[2], twoApps), 'iPad', 'a unique name stays as is');
  assert.equal(playerLabel(twoApps[1], twoApps), 'Apple TV (Infuse)');
  // "Plex for Apple TV" shortens to the player's own name, which tells nothing, so the ID is used.
  assert.equal(playerLabel(twoApps[0], twoApps), 'Apple TV (ATV-PLEX)');
  const same = [{ id: 'AAAAAAAA1', name: 'TV', product: 'Plex for LG' }, { id: 'BBBBBBBB2', name: 'TV', product: 'Plex for LG' }];
  assert.equal(playerLabel(same[0], same), 'TV (AAAAAAAA)');
  const sel = { players: twoApps };
  const sensor = { type: 'occupancy', state: 'playing', filters: { players: ['ATV-PLEX', twoApps[1].id], users: [], libraries: [] } };
  assert.match(summarize(sensor, sel), /Apple TV \(ATV-PLEX\).*Apple TV \(Infuse\)/);
});

test('sensors follow new setup choices only where they matched the old ones', () => {
  const before = { players: [twoApps[0]], allUsers: true, users: [], libraries: [{ key: 'm' }] };
  const after = { players: [twoApps[0], twoApps[1]], allUsers: true, users: [], libraries: [{ key: 'm' }, { key: 'tv' }] };
  const sensors = [
    { id: 'a', filters: { players: ['ATV-PLEX'], users: [], libraries: ['m'] } },
    { id: 'b', filters: { players: ['IPAD'], users: [], libraries: ['m'] } },
    { id: 'c', filters: { players: [], users: [], libraries: ['m', 'x'] } },
  ];
  const { sensors: result, followedLibraries, changed } = followSelection(sensors, before, after);
  assert.deepEqual(result[0].filters, { players: ['ATV-PLEX', twoApps[1].id], users: [], libraries: ['m', 'tv'] });
  assert.deepEqual(result[1].filters, { players: ['IPAD'], users: [], libraries: ['m', 'tv'] }, 'players set by hand stay');
  assert.deepEqual(result[2].filters.libraries, ['m', 'x'], 'libraries set by hand stay');
  assert.deepEqual([...followedLibraries], ['a', 'b']);
  assert.equal(changed, 2);
  assert.equal(followSelection(sensors, undefined, after).changed, 0, 'first setup changes nothing');
});

test('a player chosen in setup but left off sensors is offered, until dismissed', () => {
  const selection = { players: twoApps.slice(0, 2), allUsers: true, users: [], libraries: [] };
  const sensors = [
    { id: 'a', filters: { players: ['ATV-PLEX'] } },
    { id: 'b', filters: { players: ['ATV-PLEX', twoApps[1].id] } },
    { id: 'c', filters: { players: [] } },
    { id: 'd', filters: { players: ['IPAD'] } },
  ];
  const missing = missingSetupPlayers(sensors, selection);
  assert.deepEqual(missing.players.map((p) => p.product), ['Infuse']);
  assert.deepEqual(missing.sensorIds, ['a']);
  assert.equal(missingSetupPlayers(sensors, { ...selection, dismissedPlayers: [twoApps[1].id] }).players.length, 0);
  assert.equal(missingSetupPlayers(sensors, { ...selection, allPlayers: true }).players.length, 0);
});
