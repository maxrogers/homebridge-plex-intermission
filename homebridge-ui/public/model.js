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
  return CREDITS_MODES[timing.midCredits] ? timing.midCredits : 'scenes';
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

/** Library kinds from discovery: how each is labelled, and whether setup chooses it for you. */
export const LIBRARY_KINDS = {
  movie: { label: 'Movies', preselect: true },
  show: { label: 'TV Shows', preselect: true },
  other: { label: 'Other Videos' },
  music: { label: 'Music' },
  photo: { label: 'Photos' },
  livetv: { label: 'Live TV' },
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

/** Advanced settings. Values are stored in config `timing` in seconds; `scale` converts for display. */
export const TIMING_FIELDS = [
  { key: 'creditsOffset', label: 'Credits offset', help: 'Wait this long after the credits marker. Never earlier than the marker.', unit: 's', min: 0, max: 120, default: 0 },
  { key: 'rearmDistance', label: 'Credits re-arm distance', help: 'Rewinds shorter than this never change the credits state, so the rewind Plex does on resume can\'t flick a sensor.', unit: 's', min: 20, max: 600, default: 60 },
  { key: 'pauseDebounce', label: 'Pause debounce', help: 'Pauses shorter than this are ignored, so skips and quick pause-play bursts don\'t change any sensor. Apple TV skips take up to about 1.3 seconds.', unit: 's', min: 0, max: 30, step: 0.5, default: 1.5 },
  { key: 'stopHold', label: 'Stop hold', help: 'After playback stops near the end of an item, sensors keep their state this long in case the next episode autoplays. A stop anywhere else counts after 1 second. Raise it if your player\'s autoplay countdown is longer.', unit: 's', min: 0, max: 60, default: 10 },
  { key: 'minItemLength', label: 'Minimum item length', help: 'Shorter items, such as trailers, are ignored. 0 turns this off.', unit: 'min', scale: 60, min: 0, max: 60, default: 0 },
  { key: 'safetyResync', label: 'Safety re-sync', help: 'How often to re-read playback while the connection to Plex is down and something is playing. 0 turns this off.', unit: 'min', scale: 60, storedIn: 'min', min: 0, max: 30, default: 5 },
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

/**
 * A name the Home app accepts: letters, numbers, spaces and common punctuation, starting and ending
 * with a letter or number (HAP-NodeJS warns about anything else, and Home may refuse the accessory).
 */
export function homeKitName(name, fallback = 'Sensor') {
  const cleaned = name
    .replace(/[^\p{L}\p{N}\p{Zs}\u2019'&!._:;()/,-]/gu, '')
    .replace(/\s+/g, ' ')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  if (cleaned.length >= 2) {
    return cleaned;
  }
  return cleaned ? `${cleaned} ${fallback}` : fallback;
}

export function sensorId() {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return `s-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const emptyFilters = () => ({ players: [], devices: [], exceptPlayers: [], users: [], libraries: [] });

/* ---------- devices ---------- */

export function deviceId() {
  return `d-${sensorId().slice(2)}`;
}

const nameKey = (name) => (name ?? '').trim().toLowerCase();

/**
 * Players grouped into devices by the name their apps report, most used first. Every app on an
 * Apple TV reports the Apple TV's name, so one group is one device (or several with one name).
 */
export function deviceGroups(players = []) {
  const groups = new Map();
  for (const player of players) {
    const key = nameKey(player.name);
    const group = groups.get(key) ?? { match: player.name, apps: [], plays: 0, playingNow: false, lastUsedAt: 0 };
    group.apps.push(player);
    group.plays += player.plays ?? 0;
    group.playingNow ||= player.playingNow === true;
    group.lastUsedAt = Math.max(group.lastUsedAt, player.lastUsedAt ?? 0);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => Number(b.playingNow) - Number(a.playingNow) || b.plays - a.plays || b.lastUsedAt - a.lastUsedAt);
}

/** The device that takes every app reporting `match`, or undefined. Devices narrowed to apps don't count. */
export function deviceFor(devices = [], match) {
  return devices.find((d) => !(d.apps?.length) && nameKey(d.match) === nameKey(match));
}

/** A new device taking every app that reports `match`. */
export function newDevice(match) {
  return { id: deviceId(), name: match, match };
}

/** Devices in `extra` that `devices` lacks (by ID), added. */
export function mergeDevices(devices = [], extra = []) {
  return [...devices.map((d) => extra.find((e) => e.id === d.id) ?? d), ...extra.filter((e) => !devices.some((d) => d.id === e.id))];
}

/** Devices any sensor or the setup choices use; the rest are dropped. */
export function usedDevices(config) {
  const used = new Set([...(config.selection?.devices ?? []).map((d) => d.id), ...(config.sensors ?? []).flatMap((s) => s.filters?.devices ?? [])]);
  return (config.devices ?? []).filter((d) => used.has(d.id));
}

/** Whether a known app is on a device: one of its pinned apps, or any app reporting its name. */
export function appOnDevice(device, player) {
  return device.apps?.length ? device.apps.includes(player.id) : nameKey(device.match) === nameKey(player.name);
}

/**
 * Moves player choices made one app at a time (before 1.1) to devices. Each chosen player's name
 * becomes a device; known apps with that name that were not chosen are left out, so nothing that
 * was ignored starts counting. Players whose name is unknown stay as they are.
 * `known` lists every player the page knows (discovery and players seen). Returns undefined when
 * there is nothing to move.
 */
export function migrateToDevices(config, known = []) {
  const selection = config.selection ?? {};
  const legacy = [...(selection.players ?? []).map((p) => p.id), ...(config.sensors ?? []).flatMap((s) => s.filters?.players ?? [])];
  const nameOf = (id) => (selection.players ?? []).find((p) => p.id === id)?.name ?? known.find((p) => p.id === id)?.name;
  if (!legacy.some(nameOf)) {
    return undefined;
  }
  let devices = [...(config.devices ?? [])];
  const deviceOf = (name) => {
    let device = deviceFor(devices, name);
    if (!device) {
      device = newDevice(name);
      devices = [...devices, device];
    }
    return device;
  };
  const sameName = (name) => [...new Map([...(selection.players ?? []), ...known].filter((p) => nameKey(p.name) === nameKey(name)).map((p) => [p.id, p])).keys()];
  const convert = (ids, except = []) => {
    const named = ids.filter((id) => nameOf(id));
    const devicesUsed = [...new Map(named.map((id) => deviceOf(nameOf(id))).map((d) => [d.id, d])).values()];
    const left = devicesUsed.flatMap((d) => sameName(d.match).filter((id) => !ids.includes(id)));
    return { players: ids.filter((id) => !nameOf(id)), devices: devicesUsed.map((d) => d.id), exceptPlayers: [...new Set([...except, ...left])] };
  };
  const chosen = convert((selection.players ?? []).map((p) => p.id), selection.exceptPlayers ?? []);
  const sensors = (config.sensors ?? []).map((s) => {
    const players = s.filters?.players ?? [];
    if (players.length === 0) {
      return s;
    }
    const moved = convert(players, s.filters.exceptPlayers ?? []);
    return { ...s, filters: { ...s.filters, players: moved.players, devices: [...new Set([...(s.filters.devices ?? []), ...moved.devices])], exceptPlayers: moved.exceptPlayers } };
  });
  return {
    ...config,
    devices,
    selection: {
      ...selection,
      players: (selection.players ?? []).filter((p) => chosen.players.includes(p.id)),
      devices: [...(selection.devices ?? []), ...chosen.devices.map((id) => devices.find((d) => d.id === id)).filter((d) => !(selection.devices ?? []).some((s) => s.id === d.id))],
      exceptPlayers: chosen.exceptPlayers,
    },
    sensors,
  };
}

/** A new sensor or button, starting from the setup's players, people and libraries when given. */
export function newSensor(type = 'occupancy', selection) {
  const filters = selection ? filtersFrom(selection) : emptyFilters();
  return SENSOR_TYPES[type].state
    ? { id: sensorId(), name: 'New sensor', type, state: 'playing', except: ['credits'], filters }
    : { id: sensorId(), name: 'New button', type, events: ['play'], filters };
}

/** Filters for the choices made during setup: the chosen devices and players, users and libraries. */
export function filtersFrom(selection) {
  return {
    players: selection.allPlayers ? [] : (selection.players ?? []).map((p) => p.id),
    devices: selection.allPlayers ? [] : (selection.devices ?? []).map((d) => d.id),
    exceptPlayers: selection.allPlayers ? [] : [...(selection.exceptPlayers ?? [])],
    users: selection.allUsers === false ? [...(selection.users ?? [])] : [],
    libraries: selection.allLibraries ? [] : (selection.libraries ?? []).map((l) => l.key),
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
 * Presets the sensors were set up from, in preset order. Every State is recognised by its group;
 * Simple and Simple + Credits by a lone Playing sensor (without or with the credits exception) that
 * has no media conditions.
 */
export function presetsInUse(sensors) {
  const used = new Set();
  for (const s of sensors ?? []) {
    if (s.group) {
      if (PRESETS.some((p) => p.id === groupPreset(s.group))) {
        used.add(groupPreset(s.group));
      }
    } else if (SENSOR_TYPES[s.type]?.state && s.state === 'playing' && !hasMediaConditions(s)) {
      const except = s.except ?? [];
      if (except.length === 0) {
        used.add('simple');
      } else if (except.length === 1 && except[0] === 'credits') {
        used.add('credits');
      }
    }
  }
  return PRESETS.map((p) => p.id).filter((id) => used.has(id));
}

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
  const scope = (s) => [s.filters?.players ?? [], s.filters?.devices ?? [], s.filters?.exceptPlayers ?? [], s.filters?.users ?? [], s.filters?.libraries ?? [], s.media ?? {}]
    .map((v) => (Array.isArray(v) ? [...v].sort() : v));
  return same(want, have) && members.every((m) => same(scope(m), scope(members[0])));
}

export function libraryRef(server, library) {
  return { key: library.key, title: library.title, kind: library.kind, serverId: server.id, serverName: server.name };
}

/** Initial choices: the device playing now or the most used one, all Plex Home users, and every Movies and TV library. */
export function defaultSelection(discovery) {
  const groups = deviceGroups(discovery.players ?? []);
  return {
    allPlayers: groups.length === 0,
    players: [],
    devices: groups.slice(0, 1).map((g) => newDevice(g.match)),
    exceptPlayers: [],
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

/** A product name without the "Plex for" prefix, for example "Apple TV" or "Infuse". */
const shortProduct = (product) => (product ? product.replace(/^Plex (for|Media Player for) /i, '') : undefined);

/**
 * A player's name, with its app or the start of its ID added when another player in `players` has the
 * same name (two apps on one Apple TV are both called "Apple TV").
 */
export function playerLabel(player, players = []) {
  if (!player) {
    return '';
  }
  const twins = players.filter((p) => p.id !== player.id && p.name === player.name);
  if (twins.length === 0) {
    return player.name;
  }
  const product = shortProduct(player.product);
  const tell = product && product !== player.name && !twins.some((t) => shortProduct(t.product) === product) ? product : player.id.slice(0, 8);
  return `${player.name} (${tell})`;
}

/**
 * Brings sensors along when the setup choices change: a sensor whose players, people or libraries
 * were exactly the old choices gets the new ones; filters set by hand stay as they are. Returns the
 * sensors, and the IDs of those whose libraries followed.
 */
export function followSelection(sensors, before, after) {
  if (!before) {
    return { sensors, followedLibraries: new Set(), changed: 0 };
  }
  const was = filtersFrom(before);
  const now = filtersFrom(after);
  const same = (a = [], b = []) => a.length === b.length && a.every((v) => b.includes(v));
  const followedLibraries = new Set();
  let changed = 0;
  const result = sensors.map((sensor) => {
    const filters = { ...sensor.filters };
    let touched = false;
    for (const key of ['players', 'devices', 'exceptPlayers', 'users', 'libraries']) {
      if (same(filters[key], was[key]) && !same(was[key], now[key])) {
        filters[key] = [...now[key]];
        touched = true;
        if (key === 'libraries') {
          followedLibraries.add(sensor.id);
        }
      }
    }
    changed += touched ? 1 : 0;
    return touched ? { ...sensor, filters } : sensor;
  });
  return { sensors: result, followedLibraries, changed };
}

/**
 * Players chosen in setup that some sensors leave out, though those sensors otherwise watch only
 * setup players (so they look like they were meant to follow setup). Players in `dismissedPlayers` are
 * left out. Returns the players and sensor IDs.
 */
export function missingSetupPlayers(sensors, selection, known = []) {
  const dismissed = selection?.dismissedPlayers ?? [];
  // Devices: apps a sensor leaves out though setup includes them, on sensors with the setup's devices.
  const setupDevices = (selection?.devices ?? []).map((d) => d.id).sort().join();
  const setupExcept = selection?.exceptPlayers ?? [];
  const deviceSensors = setupDevices ? sensors.filter((s) => [...(s.filters?.devices ?? [])].sort().join() === setupDevices) : [];
  const leftOut = deviceSensors.filter((s) => (s.filters.exceptPlayers ?? []).some((id) => !setupExcept.includes(id) && !dismissed.includes(id)));
  if (leftOut.length > 0) {
    const ids = [...new Set(leftOut.flatMap((s) => s.filters.exceptPlayers.filter((id) => !setupExcept.includes(id) && !dismissed.includes(id))))];
    return { players: ids.map((id) => known.find((p) => p.id === id) ?? { id, name: id }), sensorIds: leftOut.map((s) => s.id), leftOut: true };
  }
  const all = selection?.allPlayers ? [] : (selection?.players ?? []);
  const ids = all.map((p) => p.id);
  const chosen = all.filter((p) => !dismissed.includes(p.id));
  const affected = sensors.filter((s) => {
    const players = s.filters?.players ?? [];
    return players.length > 0 && players.every((id) => ids.includes(id)) && chosen.some((p) => !players.includes(p.id));
  });
  const missing = chosen.filter((p) => affected.some((s) => !s.filters.players.includes(p.id)));
  return { players: missing, sensorIds: affected.map((s) => s.id) };
}

const sameText = (a, b) => typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();

/** Players Intermission saw play in the last 30 days that may be a chosen player with a new Plex ID. */
const RECENT_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Players that played recently, are on no sensor, and are either followed as a chosen player (same
 * name, app and address) or share a chosen player's name (and app, when both are known). Each comes
 * with the chosen players it stands for. `records` is players.json as the settings server returns it.
 */
export function newPlayerIds(records, selection, sensors, { now = Date.now(), devices = [] } = {}) {
  const used = new Set(sensors.flatMap((s) => s.filters?.devices ?? []));
  const pinned = new Set(devices.filter((d) => used.has(d.id)).flatMap((d) => d.apps ?? []));
  const chosen = new Set([...sensors.flatMap((s) => s.filters?.players ?? []), ...pinned]);
  if (chosen.size === 0 || !records) {
    return [];
  }
  const dismissed = selection?.dismissedPlayers ?? [];
  // A pinned app is known at least by its device's name.
  const deviceName = (id) => devices.find((d) => (d.apps ?? []).includes(id))?.match;
  const known = (id) => ({ name: deviceName(id), ...(selection?.players ?? []).find((p) => p.id === id), ...records.seen?.[id] });
  return Object.entries(records.seen ?? {})
    .filter(([id, seen]) => !chosen.has(id) && !dismissed.includes(id) && now - Date.parse(seen.lastPlayedAt) < RECENT_MS)
    .map(([id, seen]) => {
      const followed = (records.followed?.[id] ?? []).filter((target) => chosen.has(target));
      const targets = followed.length > 0 ? followed : [...chosen].filter((target) => {
        const other = known(target);
        return sameText(other.name, seen.name) && (pinned.has(target) || !other.product || !seen.product || sameText(other.product, seen.product));
      });
      return { id, name: seen.name ?? id, product: seen.product, lastPlayedAt: seen.lastPlayedAt, followed: followed.length > 0, targets };
    })
    .filter((player) => player.targets.length > 0)
    .sort((a, b) => Date.parse(b.lastPlayedAt) - Date.parse(a.lastPlayedAt));
}

/**
 * Adds a new player ID where the players it stands for (`targets`) are: to devices narrowed to those
 * apps, and to sensors and setup choices that list them one by one.
 */
export function addPlayerId(config, player) {
  const ref = { id: player.id, name: player.name, ...(player.product ? { product: player.product } : {}) };
  const selection = config.selection ?? { players: [], allUsers: true, users: [], libraries: [] };
  const grow = (d) => ((d.apps ?? []).some((id) => player.targets.includes(id)) && !d.apps.includes(player.id) ? { ...d, apps: [...d.apps, player.id] } : d);
  const listed = (selection.players ?? []).some((p) => player.targets.includes(p.id));
  return {
    ...config,
    devices: (config.devices ?? []).map(grow),
    selection: {
      ...selection,
      devices: (selection.devices ?? []).map(grow),
      players: listed ? [...(selection.players ?? []).filter((p) => p.id !== player.id), ref] : (selection.players ?? []),
    },
    sensors: config.sensors.map((s) => ((s.filters?.players ?? []).some((id) => player.targets.includes(id)) && !s.filters.players.includes(player.id)
      ? { ...s, filters: { ...s.filters, players: [...s.filters.players, player.id] } }
      : s)),
  };
}

/** One plain-language line describing what a sensor does. */
export function summarize(sensor, selection = {}) {
  const name = (items, id, key, field = 'id') => items?.find((item) => item[field] === id)?.[key] ?? id;
  const player = (id) => {
    const found = selection.players?.find((p) => p.id === id);
    return found ? playerLabel(found, selection.players) : id;
  };
  const except = CAN_EXCEPT.includes(sensor.state) ? (sensor.except ?? []) : [];
  const when = SENSOR_TYPES[sensor.type]?.state
    ? `On while ${({ idle: 'nothing is playing', active: 'playing or paused', credits: 'in the credits', intro: 'in the intro' })[sensor.state] ?? (CONDITIONS[sensor.state] ?? CONDITIONS.playing).toLowerCase()}${except.length ? `, except during ${except.map((e) => EXCEPTIONS[e]?.label ?? e).join(' and ')}` : ''}`
    : `Pressed when ${list((sensor.events ?? []).map((e) => EVENTS[e]?.phrase ?? e), 'nothing (choose an event)')}`;
  const f = { ...emptyFilters(), ...sensor.filters };
  const known = [...(selection.players ?? []), ...(selection.known ?? [])];
  const appName = (id) => {
    const found = known.find((p) => p.id === id);
    return found ? (shortProduct(found.product) && shortProduct(found.product) !== found.name ? shortProduct(found.product) : `app ${id.slice(0, 8)}`) : `app ${id.slice(0, 8)}`;
  };
  const device = (id) => {
    const found = (selection.devices ?? []).find((d) => d.id === id);
    if (!found) {
      return 'a removed device';
    }
    const left = f.exceptPlayers.filter((pid) => known.some((p) => p.id === pid && appOnDevice(found, p)));
    return `${found.name}${left.length ? ` (not ${left.map(appName).join(' or ')})` : ''}`;
  };
  const where = list([...f.devices.map(device), ...f.players.map(player)], 'any player');
  const what = list(f.libraries.map((key) => name(selection.libraries, key, 'title', 'key')), 'anything');
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

/** Writes a displayed value back to config `timing`, clamped to the field's range. An empty field means the default. */
export function setTiming(timing, field, value) {
  const step = field.step ?? 1;
  const typed = String(value ?? '').trim() === '' ? NaN : Number(value);
  const number = Math.min(field.max, Math.max(field.min, Math.round(typed / step) * step));
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
  // Saved players take Plex's current name and app, so same-name players can be told apart.
  const players = (selection.players ?? []).map((p) => {
    const found = discovery.players?.find((d) => d.id === p.id);
    return found ? playerRef(found) : p;
  });
  return {
    ...selection,
    players,
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
