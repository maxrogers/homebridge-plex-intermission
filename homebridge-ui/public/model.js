// Settings-page data: labels, the suggested setups and config helpers. No DOM here, so it can be tested in Node.

export const PLATFORM = 'PlexIntermission';

export const SENSOR_TYPES = {
  occupancy: { label: 'Occupancy sensor', state: true, recommended: true, help: 'On while the condition is true. Home can always read it, so a missed update corrects itself. Quiet: no notifications.' },
  motion: { label: 'Motion sensor', state: true, help: 'Works like occupancy but shows as motion in Apple Home, which can send notifications.' },
  contact: { label: 'Contact sensor', state: true, help: 'Shows as open while the condition is true. Use it if the room already has an occupancy sensor you want to keep apart.' },
  button: { label: 'Button', state: false, help: 'A single press when something happens. A press Home misses (hub offline, restart) is gone for good, so prefer a sensor; use buttons for one-off actions.' },
};

export const CONDITIONS = {
  playing: 'Playing',
  paused: 'Paused',
  active: 'Playing or paused',
  credits: 'In the credits',
  intro: 'In the intro',
  idle: 'Nothing playing',
};

/** Conditions that can leave out the credits or intro, and what each exception means. */
export const EXCEPTIONS = {
  credits: { label: 'the credits', chip: 'Credits', help: 'Off during the credits.' },
  intro: { label: 'the intro', chip: 'Intros', help: 'Off while an intro plays (Plex finds intros on servers with Plex Pass).' },
};
export const CAN_EXCEPT = ['playing', 'paused', 'active'];

/**
 * What counts as the credits. One setting shared by every sensor, so sensors that follow the
 * credits always agree (Every State relies on that).
 */
export const CREDITS_MODES = {
  scenes: { label: 'Mid-credits scenes count as playing', help: 'Credits start at the first credits. A mid-credits scene counts as playing, then the credits resume.', default: true },
  first: { label: 'Mid-credits scenes count as credits', help: 'Credits run from the first credits to the end, including any mid-credits scenes.' },
  final: { label: 'Final credits only', help: 'Earlier credits and mid-credits scenes count as playing. Credits start at the final credits, or the first credits if there are no scenes.' },
};
export function creditsMode(timing = {}) {
  return timing.midCredits ?? (timing.firstCreditsMarker === false ? 'final' : 'scenes');
}

/** Whether a sensor's behavior depends on what counts as the credits. */
export function usesCredits(sensor) {
  return sensor.state === 'credits' || (CAN_EXCEPT.includes(sensor.state) && (sensor.except ?? []).includes('credits'));
}

/** `plexPass: true` marks events that only arrive through Plex webhooks. */
export const EVENTS = {
  play: { label: 'Playback starts', phrase: 'playback starts' },
  resume: { label: 'Resumed', phrase: 'playback resumes' },
  pause: { label: 'Paused', phrase: 'playback pauses' },
  stop: { label: 'Stopped', phrase: 'playback stops' },
  seek: { label: 'Skipped or rewound', phrase: 'someone skips or rewinds' },
  'credits.start': { label: 'Credits start', phrase: 'the credits start' },
  'credits.cancel': { label: 'Credits stop (rewind or mid-credits scene)', phrase: 'the credits stop for a rewind or a mid-credits scene' },
  'intro.start': { label: 'Intro starts', phrase: 'an intro starts' },
  'intro.end': { label: 'Intro ends or is skipped', phrase: 'an intro ends or is skipped' },
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
  livetv: { label: 'Live TV', mediaTypes: ['episode', 'movie'] },
};

/* ---------- media conditions ---------- */

export const SHAPES = { wide: 'Wide (2.2:1 or wider)', standard: 'Standard (narrower than 2.2:1)' };
export const RESOLUTIONS = { '4k': '4K', hd: 'HD', sd: 'SD' };
export const DYNAMIC_RANGES = { hdr: 'HDR (includes Dolby Vision)', dv: 'Dolby Vision', sdr: 'SDR' };
export const RATINGS = ['G', 'PG', 'PG-13', 'R', 'NC-17', 'TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA', 'NR'];
export const WIDE_ASPECT = 2.2;

export function hasMediaConditions(sensor) {
  return Object.values(sensor.media ?? {}).some((v) => (Array.isArray(v) ? v.length > 0 : v !== undefined));
}

/** Plain-language phrases for a sensor's media conditions. */
export function mediaPhrases(media = {}) {
  const or = (values) => (values.length <= 2 ? values.join(' or ') : `${values.slice(0, -1).join(', ')} or ${values.at(-1)}`);
  return [
    media.shape && (media.shape === 'wide' ? 'a wide picture' : 'a standard picture'),
    media.resolution?.length && or(media.resolution.map((r) => RESOLUTIONS[r] ?? r)),
    media.dynamicRange?.length && or(media.dynamicRange.map((r) => ({ hdr: 'HDR', dv: 'Dolby Vision', sdr: 'SDR' })[r] ?? r)),
    media.ratings?.length && `rated ${or(media.ratings)}`,
    media.labels?.length && `labeled ${or(media.labels.map((l) => `"${l}"`))}`,
  ].filter(Boolean);
}

/** Describes media details from Plex the way the Now playing panel shows them. */
export function describeFacts(facts) {
  if (!facts) {
    return {};
  }
  const ratio = facts.aspectRatio;
  return {
    shape: ratio === undefined ? undefined : `${ratio >= WIDE_ASPECT ? 'Wide' : 'Standard'} ${ratio.toFixed(2)}:1`,
    shapeValue: ratio === undefined ? undefined : (ratio >= WIDE_ASPECT ? 'wide' : 'standard'),
    resolution: facts.resolution ? RESOLUTIONS[facts.resolution] : undefined,
    dynamicRange: facts.dynamicRange ? ({ hdr: 'HDR', dv: 'Dolby Vision', sdr: 'SDR' })[facts.dynamicRange] : undefined,
    rating: facts.contentRating,
    labels: facts.labels ?? [],
  };
}

/** Media types the chosen libraries can play, in display order. */
export function availableMediaTypes(libraries) {
  const types = new Set((libraries ?? []).flatMap((l) => LIBRARY_KINDS[l.kind]?.mediaTypes ?? []));
  return Object.keys(MEDIA_TYPES).filter((type) => types.has(type));
}

/** Advanced settings. Values are stored in config `timing` in seconds; `scale` converts for display. */
export const TIMING_FIELDS = [
  { key: 'creditsOffset', label: 'Credits offset', help: 'Wait this long after the credits marker. Never earlier than the marker.', unit: 's', min: 0, max: 120, default: 0 },
  { key: 'rearmDistance', label: 'Credits re-arm distance', help: 'Rewinds shorter than this never change the credits state, so the rewind Plex does on resume can\'t flick a sensor.', unit: 's', min: 20, max: 600, default: 60 },
  { key: 'pauseDebounce', label: 'Pause debounce', help: 'Pauses shorter than this are ignored, so skips and quick pause-play bursts don\'t change any sensor.', unit: 's', min: 0, max: 30, default: 2 },
  { key: 'stopHold', label: 'Stop hold', help: 'After playback stops, sensors keep their state this long in case the next episode autoplays. Raise it if your player\'s autoplay countdown is longer.', unit: 's', min: 0, max: 60, default: 10 },
  { key: 'minItemLength', label: 'Minimum item length', help: 'Shorter items, such as trailers, are ignored. 0 turns this off.', unit: 'min', scale: 60, min: 0, max: 60, default: 0 },
  { key: 'safetyResync', label: 'Safety re-sync', help: 'Only while the connection to Plex is down and something plays. 0 turns this off.', unit: 'min', scale: 60, storedIn: 'min', min: 0, max: 30, default: 5 },
];

export const DEFAULT_WEBHOOK_PORT = 32550;

/**
 * A child bridge for Intermission, as Homebridge's own "Use Child Bridge" makes one: a random,
 * locally administered MAC-style ID, and a fixed port clear of Homebridge's default (51826).
 */
export function newChildBridge(random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))) {
  const bytes = random(8);
  bytes[0] = (bytes[0] & 0xfc) | 0x02;
  const username = [...bytes.slice(0, 6)].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
  let port = 51000 + (((bytes[6] << 8) | bytes[7]) % 6000);
  if (port === 51826) {
    port += 1;
  }
  return { username, port, name: 'Intermission' };
}

export function sensorId() {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return `s-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const emptyFilters = () => ({ players: [], users: [], libraries: [], mediaTypes: [] });

export function newSensor(type = 'occupancy') {
  return SENSOR_TYPES[type].state
    ? { id: sensorId(), name: 'New sensor', type, state: 'playing', except: ['credits'], filters: emptyFilters() }
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
    creditsAware: false,
    tagline: 'One sensor. Lights down while playing.',
    about: 'On while anything plays, including the credits. Off when you pause or stop. One automation each way.',
    sensors: [
      { name: 'Media Playing', type: 'occupancy', state: 'playing', why: 'On while playing. Dim the lights when it turns on; bring them up when it turns off.' },
    ],
  },
  {
    id: 'credits',
    name: 'Simple + Credits',
    creditsAware: true,
    tagline: 'One sensor. Lights up for the credits too.',
    recommended: true,
    about: 'Like Simple, but the sensor also turns off for the credits. By default it turns back on for a mid-credits scene and off again after it (What counts as the credits, in Settings).',
    sensors: [
      { name: 'Media Playing', type: 'occupancy', state: 'playing', except: ['credits'], why: 'On while playing, except during the credits. Dim the lights when it turns on; bring them up when it turns off.' },
    ],
  },
  {
    id: 'states',
    name: 'Every State',
    creditsAware: true,
    tagline: 'Four sensors. Different lighting for playing, pause, credits and the end.',
    about: 'One sensor per state, exactly one on at a time, so each moment can have its own scene or fade speed.',
    sensors: [
      { name: 'Media Playing', type: 'occupancy', state: 'playing', except: ['credits'], why: 'On while playing, except during the credits. Dim the lights.' },
      { name: 'Media Paused', type: 'occupancy', state: 'paused', except: ['credits'], why: 'On while paused for more than a moment. Bring the lights up a little.' },
      { name: 'Credits Rolling', type: 'occupancy', state: 'credits', why: 'On during the credits (movies and TV). Fade the lights up slowly.' },
      { name: 'Nothing Playing', type: 'occupancy', state: 'idle', why: 'On when playback ends, unless the next episode starts. Normal lighting.' },
    ],
  },
];

export const DEFAULT_PRESET = 'credits';

/** Presets whose sensors work as a set (exactly one on at a time) and are shown grouped. */
export const GROUPED_PRESETS = ['states'];

export function presetSensors(id, selection) {
  const preset = PRESETS.find((p) => p.id === id);
  const group = GROUPED_PRESETS.includes(id) ? `${id}:${sensorId().slice(2)}` : undefined;
  return (preset?.sensors ?? []).map(({ name, type, state, except = [] }) => ({
    id: sensorId(), name, type, state, except: [...except], filters: filtersFrom(selection), ...(group ? { group } : {}),
  }));
}

/** The preset a group belongs to, from its `group` value (`states:ab12cd34`). */
export const groupPreset = (group) => (group ? group.split(':')[0] : undefined);

/**
 * Adds a preset to existing sensors.
 * - `alongside` keeps every sensor; new names that clash get " 2", " 3"...
 * - `replace` removes the existing sensors, but a preset sensor whose name matches an existing one
 *   takes over that sensor's identity (and filters and commands), so Home automations using it keep working.
 */
export function applyPreset(sensors, id, selection, mode = 'alongside') {
  const added = presetSensors(id, selection);
  if (mode === 'replace') {
    return added.map((sensor) => {
      const same = sensors.find((s) => s.name.toLowerCase() === sensor.name.toLowerCase());
      return same ? { ...sensor, id: same.id, filters: same.filters, ...(same.run ? { run: same.run } : {}) } : sensor;
    });
  }
  const names = new Set(sensors.map((s) => s.name.toLowerCase()));
  return [...sensors, ...added.map((sensor) => {
    let name = sensor.name;
    for (let n = 2; names.has(name.toLowerCase()); n += 1) {
      name = `${sensor.name} ${n}`;
    }
    names.add(name.toLowerCase());
    return { ...sensor, name };
  })];
}

/**
 * Whether an Every State group still works as a set: one of each of its states, set up as the
 * preset made them, with the same players, people, libraries and media conditions.
 */
export function groupIntact(members) {
  const preset = PRESETS.find((p) => p.id === groupPreset(members[0]?.group));
  if (!preset || members.length !== preset.sensors.length) {
    return false;
  }
  const key = (s) => `${s.state}:${[...(s.except ?? [])].sort().join('+')}`;
  const want = preset.sensors.map((s) => `${s.state}:${[...(s.except ?? [])].sort().join('+')}`).sort();
  const have = members.map((s) => (SENSOR_TYPES[s.type]?.state ? key(s) : 'button')).sort();
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const scope = (s) => [s.filters?.players ?? [], s.filters?.users ?? [], s.filters?.libraries ?? [], s.filters?.mediaTypes ?? [], s.media ?? {}]
    .map((v) => (Array.isArray(v) ? [...v].sort() : v));
  return same(want, have) && members.every((m) => same(scope(m), scope(members[0])));
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
  const except = CAN_EXCEPT.includes(sensor.state) ? (sensor.except ?? []) : [];
  const when = SENSOR_TYPES[sensor.type]?.state
    ? `On while ${({ idle: 'nothing is playing', active: 'playing or paused', credits: 'in the credits', intro: 'in the intro' })[sensor.state] ?? (CONDITIONS[sensor.state] ?? CONDITIONS.playing).toLowerCase()}${except.length ? `, except during ${except.map((e) => EXCEPTIONS[e]?.label ?? e).join(' and ')}` : ''}`
    : `Pressed when ${list((sensor.events ?? []).map((e) => EVENTS[e]?.phrase ?? e), 'nothing (choose an event)')}`;
  const f = sensor.filters ?? emptyFilters();
  const where = list(f.players.map((id) => name(selection.players, id, 'name')), 'any player');
  const what = list([
    ...f.libraries.map((key) => name(selection.libraries, key, 'title', 'key')),
    ...f.mediaTypes.map((t) => MEDIA_TYPES[t] ?? t),
  ], 'anything');
  const who = list(f.users, 'anyone');
  const media = SENSOR_TYPES[sensor.type]?.state ? mediaPhrases(sensor.media) : [];
  return `${when}, on ${where}, for ${what}${media.length ? ` with ${media.join(', ')}` : ''}, by ${who}.`;
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

/* ---------- changing servers ---------- */

const libraryRefs = (discovery) => (discovery.servers ?? []).flatMap((server) => server.libraries.map((l) => libraryRef(server, l)));

/**
 * Brings the setup choices in line with the servers just discovered: libraries of servers no longer
 * chosen are dropped, and each newly added server gets its Movies and TV libraries chosen.
 */
export function reconcileSelection(selection, discovery, previousServerIds = []) {
  const available = libraryRefs(discovery);
  const keys = new Set(available.map((l) => l.key));
  const added = available.filter((l) => !previousServerIds.includes(l.serverId) && LIBRARY_KINDS[l.kind]?.preselect);
  const kept = (selection.libraries ?? []).filter((l) => keys.has(l.key));
  return {
    ...selection,
    libraries: selection.allLibraries ? [] : [...kept, ...added.filter((l) => !kept.some((k) => k.key === l.key))],
  };
}

/**
 * Keeps sensors' library filters valid after servers change. A filter loses libraries that are gone,
 * and gains the new servers' libraries of the kinds it already uses (a Movies and TV sensor gets the
 * new server's Movies and TV; a Music sensor gets its Music). A filter left empty would mean "all
 * libraries", so it gets every library of its former kinds instead. "All libraries" filters stay as they are.
 */
export function reconcileSensors(sensors, discovery, previousServerIds = [], knownLibraries = []) {
  const available = libraryRefs(discovery);
  const kindOf = new Map([...knownLibraries, ...available].map((l) => [l.key, l.kind]));
  return sensors.map((sensor) => {
    const before = sensor.filters?.libraries ?? [];
    if (before.length === 0) {
      return sensor;
    }
    const kinds = new Set(before.map((key) => kindOf.get(key)).filter(Boolean));
    const kept = before.filter((key) => available.some((l) => l.key === key));
    const additions = available
      .filter((l) => (kept.length === 0 || !previousServerIds.includes(l.serverId)) && kinds.has(l.kind))
      .map((l) => l.key);
    let libraries = [...new Set([...kept, ...additions])];
    if (libraries.length === 0) {
      // Nothing of the same kinds is left: fall back to Movies and TV rather than "all libraries".
      libraries = available.filter((l) => LIBRARY_KINDS[l.kind]?.preselect).map((l) => l.key);
    }
    // Still nothing: keep the old keys, which match nothing, rather than widening to every library.
    return { ...sensor, filters: { ...sensor.filters, libraries: libraries.length > 0 ? libraries : before } };
  });
}
