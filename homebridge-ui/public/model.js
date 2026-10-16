// Settings-page data: labels, the Movie Night template and config helpers. No DOM here, so it can be tested in Node.

export const PLATFORM = 'PlexIntermission';

export const SENSOR_TYPES = {
  occupancy: { label: 'Occupancy sensor', glyph: '◉', state: true },
  motion: { label: 'Motion sensor', glyph: '≋', state: true },
  contact: { label: 'Contact sensor', glyph: '◫', state: true },
  button: { label: 'Button', glyph: '●', state: false },
};

export const CONDITIONS = {
  playing: 'Playing, before the credits',
  'playing-any': 'Playing, including the credits',
  paused: 'Paused',
  credits: 'In the credits',
  active: 'Anything playing or paused',
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

export const MEDIA_TYPES = { movie: 'Movies', episode: 'TV episodes', clip: 'Clips', track: 'Music' };

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
    players: (selection.players ?? []).map((p) => p.id),
    users: [...(selection.users ?? [])],
    libraries: (selection.libraries ?? []).map((l) => l.id),
    mediaTypes: [],
  };
}

export const MOVIE_NIGHT = [
  { name: 'Movie Playing', type: 'occupancy', state: 'playing', why: 'On while playing, off at the credits. Dim the lights when it turns on.' },
  { name: 'Movie Started', type: 'button', events: ['play', 'resume'], why: 'Pressed on play and resume.' },
  { name: 'Movie Paused', type: 'button', events: ['pause'], why: 'Pressed after a real pause. Bring the lights up quickly.' },
  { name: 'Credits Rolling', type: 'button', events: ['credits.start'], why: 'Pressed when the credits start. Fade the lights up slowly.' },
  { name: 'Movie Stopped', type: 'button', events: ['stop'], why: 'Pressed when playback ends.' },
];

export function movieNight(selection) {
  return MOVIE_NIGHT.map(({ name, type, state, events }) => ({
    id: sensorId(),
    name,
    type,
    ...(state ? { state } : { events: [...events] }),
    filters: filtersFrom(selection),
  }));
}

/** Initial choices: the most used player and the Movies and TV libraries. */
export function defaultSelection(discovery) {
  const players = discovery.players ?? [];
  const live = players.filter((p) => p.playingNow);
  return {
    players: (live.length > 0 ? live : players.slice(0, 1)).map(playerRef),
    users: [],
    libraries: (discovery.libraries ?? []).filter((l) => l.type === 'movie' || l.type === 'show'),
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
  const name = (items, id, key) => items?.find((item) => item.id === id)?.[key] ?? id;
  const when = SENSOR_TYPES[sensor.type]?.state
    ? `On while ${(CONDITIONS[sensor.state] ?? CONDITIONS.playing).toLowerCase()}`
    : `Pressed when ${list((sensor.events ?? []).map((e) => EVENTS[e]?.phrase ?? e), 'nothing (choose an event)')}`;
  const f = sensor.filters ?? emptyFilters();
  const where = list(f.players.map((id) => name(selection.players, id, 'name')), 'any player');
  const what = list([
    ...f.libraries.map((id) => name(selection.libraries, id, 'title')),
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
