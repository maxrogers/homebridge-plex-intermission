// Settings-page data: labels, the suggested setups and config helpers. No DOM here, so it can be tested in Node.

export const PLATFORM = 'PlexIntermission';

export const SENSOR_TYPES = {
  occupancy: { label: 'Occupancy sensor', state: true, recommended: true, help: 'On while the condition is true. Home can always read it, so a missed update corrects itself. Quiet: no notifications.' },
  motion: { label: 'Motion sensor', state: true, help: 'Works like occupancy but shows as motion in Apple Home, which can send notifications.' },
  contact: { label: 'Contact sensor', state: true, help: 'Shows as open while the condition is true. Use it if the room already has an occupancy sensor you want to keep apart.' },
  button: { label: 'Button', state: false, help: 'A single press when something happens. A press Home misses (hub offline, restart) is gone for good, so prefer a sensor; use buttons for one-off actions.' },
};

export const CONDITIONS = {
  playing: 'Playing, before the credits',
  'playing-any': 'Playing, including the credits',
  paused: 'Paused, outside the credits',
  credits: 'In the credits',
  active: 'Anything playing or paused',
  idle: 'Nothing playing',
};

/** `plexPass: true` marks events that only arrive through Plex webhooks. */
export const EVENTS = {
  play: { label: 'Playback starts', phrase: 'playback starts' },
  resume: { label: 'Resumed', phrase: 'playback resumes' },
  pause: { label: 'Paused', phrase: 'playback pauses' },
  stop: { label: 'Stopped', phrase: 'playback stops' },
  seek: { label: 'Skipped or rewound', phrase: 'someone skips or rewinds' },
  'credits.start': { label: 'Credits start', phrase: 'the credits start' },
  'credits.cancel': { label: 'Rewound out of the credits', phrase: 'someone rewinds out of the credits' },
  'media.scrobble': { label: 'Marked as watched', phrase: 'an item is marked as watched', plexPass: true },
  'media.rate': { label: 'Rated', phrase: 'an item is rated', plexPass: true },
  'library.new': { label: 'Added to a library', phrase: 'an item is added', plexPass: true },
  'library.on.deck': { label: 'Added to On Deck', phrase: 'an item is added to On Deck', plexPass: true },
  'playback.started': { label: 'A shared user starts playing', phrase: 'a shared user starts playing', plexPass: true },
  'device.new': { label: 'New device on the server', phrase: 'a new device appears', plexPass: true },
  'admin.database.backup': { label: 'Database backed up', phrase: 'the database is backed up', plexPass: true },
  'admin.database.corrupted': { label: 'Database corrupted', phrase: 'the database is corrupted', plexPass: true },
};

export const MEDIA_TYPES = { movie: 'Movies and other videos', episode: 'TV episodes', track: 'Music', photo: 'Photos', clip: 'Video clips' };

/** Library kinds from discovery, how they are labelled, and what Plex plays from them. */
export const LIBRARY_KINDS = {
  movie: { label: 'Movies', mediaTypes: ['movie'], preselect: true },
  show: { label: 'TV Shows', mediaTypes: ['episode'], preselect: true },
  other: { label: 'Other Videos', mediaTypes: ['movie'] },
  music: { label: 'Music', mediaTypes: ['track'] },
  photo: { label: 'Photos', mediaTypes: ['photo', 'clip'] },
};

/** Media types the chosen libraries can play, in display order. */
export function availableMediaTypes(libraries) {
  const types = new Set((libraries ?? []).flatMap((l) => LIBRARY_KINDS[l.kind]?.mediaTypes ?? []));
  return Object.keys(MEDIA_TYPES).filter((type) => types.has(type));
}

/** Advanced settings. Values are stored in config `timing` in seconds; `scale` converts for display. */
export const TIMING_FIELDS = [
  { key: 'creditsOffset', label: 'Credits offset', help: 'Wait this long after the credits marker. Never earlier than the marker.', unit: 's', min: 0, max: 120, default: 0 },
  { key: 'rearmDistance', label: 'Credits re-arm distance', help: 'Rewinding further than this before the credits ends the credits state.', unit: 's', min: 20, max: 600, default: 60 },
  { key: 'pauseDebounce', label: 'Pause debounce', help: 'Pauses shorter than this are ignored.', unit: 's', min: 0, max: 30, default: 2 },
  { key: 'stopHold', label: 'Stop hold', help: 'Waits this long after a stop, so autoplaying the next episode is not a stop.', unit: 's', min: 0, max: 60, default: 10 },
  { key: 'minItemLength', label: 'Minimum item length', help: 'Shorter items, such as trailers, are ignored. 0 turns this off.', unit: 'min', scale: 60, min: 0, max: 60, default: 0 },
  { key: 'safetyResync', label: 'Safety re-sync', help: 'Only while the connection to Plex is down and something plays. 0 turns this off.', unit: 'min', scale: 60, storedIn: 'min', min: 0, max: 30, default: 5 },
];

export const DEFAULT_WEBHOOK_PORT = 32550;

export function sensorId() {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return `s-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const emptyFilters = () => ({ players: [], users: [], libraries: [], mediaTypes: [] });

export function newSensor(type = 'occupancy') {
  return SENSOR_TYPES[type].state
    ? { id: sensorId(), name: 'New sensor', type, state: 'playing', filters: emptyFilters() }
    : { id: sensorId(), name: 'New button', type, events: ['play'], filters: emptyFilters() };
}

/** Filters for the choices made during setup: the chosen players, users and libraries. */
export function filtersFrom(selection) {
  return {
    players: selection.allPlayers ? [] : (selection.players ?? []).map((p) => p.id),
    users: selection.allUsers === false ? [...(selection.users ?? [])] : [],
    libraries: selection.allLibraries ? [] : (selection.libraries ?? []).map((l) => l.key),
    mediaTypes: [],
  };
}

/**
 * Suggested setups. All use state sensors: Home can always read a state, so a missed update corrects
 * itself (see ARCHITECTURE.md, "Sensors and buttons: lab results").
 */
export const PRESETS = [
  {
    id: 'simple',
    name: 'Simple',
    tagline: 'One sensor. Lights down while playing.',
    about: 'On while anything plays, including the credits. Off when you pause or stop. One automation each way.',
    sensors: [
      { name: 'Media Playing', type: 'occupancy', state: 'playing-any', why: 'On while playing. Dim the lights when it turns on; bring them up when it turns off.' },
    ],
  },
  {
    id: 'credits',
    name: 'Credits-Aware',
    tagline: 'One sensor. Lights up for the credits too.',
    recommended: true,
    about: 'Like Simple, but the sensor also turns off when the credits start, back on for a mid-credits scene, and off again for the rest.',
    sensors: [
      { name: 'Media Playing', type: 'occupancy', state: 'playing', why: 'On while playing, except during the credits. Dim the lights when it turns on; bring them up when it turns off.' },
    ],
  },
  {
    id: 'states',
    name: 'Every State',
    tagline: 'Four sensors. Different lighting for pause, credits and stop.',
    about: 'One sensor per state, exactly one on at a time, so each moment can have its own scene or fade speed.',
    sensors: [
      { name: 'Media Playing', type: 'occupancy', state: 'playing', why: 'On while playing, except during the credits. Dim the lights.' },
      { name: 'Media Paused', type: 'occupancy', state: 'paused', why: 'On while paused for more than a moment. Bring the lights up a little.' },
      { name: 'Credits Rolling', type: 'occupancy', state: 'credits', why: 'On during the credits (movies and TV). Fade the lights up slowly.' },
      { name: 'Nothing Playing', type: 'occupancy', state: 'idle', why: 'On when playback ends, unless the next episode starts. Normal lighting.' },
    ],
  },
];

export const DEFAULT_PRESET = 'credits';

export function presetSensors(id, selection) {
  const preset = PRESETS.find((p) => p.id === id);
  return (preset?.sensors ?? []).map(({ name, type, state }) => ({ id: sensorId(), name, type, state, filters: filtersFrom(selection) }));
}

export function libraryRef(server, library) {
  return { key: library.key, title: library.title, kind: library.kind, serverId: server.id, serverName: server.name };
}

/** Initial choices: the most used player, all Plex Home users, and every Movies and TV library. */
export function defaultSelection(discovery) {
  const players = discovery.players ?? [];
  const live = players.filter((p) => p.playingNow);
  return {
    allPlayers: players.length === 0,
    players: (live.length > 0 ? live : players.slice(0, 1)).map(playerRef),
    allUsers: true,
    allLibraries: false,
    users: [],
    libraries: (discovery.servers ?? []).flatMap((server) => server.libraries
      .filter((l) => LIBRARY_KINDS[l.kind]?.preselect)
      .map((l) => libraryRef(server, l))),
  };
}

export function playerRef(player) {
  const { id, name, product, platform, device } = player;
  return Object.fromEntries(Object.entries({ id, name, product, platform, device }).filter(([, v]) => v !== undefined));
}

function list(names, empty) {
  if (names.length === 0) {
    return empty;
  }
  return names.length <= 2 ? names.join(' or ') : `${names.slice(0, 2).join(', ')} or ${names.length - 2} more`;
}

/** One plain-language line describing what a sensor does. */
export function summarize(sensor, selection = {}) {
  const name = (items, id, key, field = 'id') => items?.find((item) => item[field] === id)?.[key] ?? id;
  const when = SENSOR_TYPES[sensor.type]?.state
    ? `On while ${(CONDITIONS[sensor.state] ?? CONDITIONS.playing).toLowerCase()}`
    : `Pressed when ${list((sensor.events ?? []).map((e) => EVENTS[e]?.phrase ?? e), 'nothing (choose an event)')}`;
  const f = sensor.filters ?? emptyFilters();
  const where = list(f.players.map((id) => name(selection.players, id, 'name')), 'any player');
  const what = list([
    ...f.libraries.map((key) => name(selection.libraries, key, 'title', 'key')),
    ...f.mediaTypes.map((t) => MEDIA_TYPES[t] ?? t),
  ], 'anything');
  const who = list(f.users, 'anyone');
  return `${when}, on ${where}, for ${what}, by ${who}.`;
}

/** True when a sensor can only trigger with Plex Pass. */
export function needsPlexPass(sensor) {
  return sensor.type === 'button' && (sensor.events ?? []).length > 0 && sensor.events.every((e) => EVENTS[e]?.plexPass);
}

/** The value shown in an Advanced field, from config `timing`. */
export function timingValue(timing, field) {
  const stored = timing?.[field.key];
  if (typeof stored !== 'number') {
    return field.default;
  }
  return field.scale && field.storedIn !== 'min' ? Math.round(stored / field.scale) : stored;
}

/** Writes a displayed value back to config `timing`, clamped to the field's range. */
export function setTiming(timing, field, value) {
  const number = Math.min(field.max, Math.max(field.min, Math.round(Number(value))));
  const next = { ...timing };
  if (!Number.isFinite(number) || number === field.default) {
    delete next[field.key];
  } else {
    next[field.key] = field.scale && field.storedIn !== 'min' ? number * field.scale : number;
  }
  return next;
}
