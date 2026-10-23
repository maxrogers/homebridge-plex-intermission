import { DEVICE_ICONS, deviceIcon, LIBRARY_ICONS, PEOPLE_ICONS, SENSOR_ICONS } from './device-icons.js';
import {
  CONDITIONS, DEFAULT_WEBHOOK_PORT, EVENTS, EXCEPTIONS, CAN_EXCEPT, CREDITS_MODES, LIBRARY_KINDS, MEDIA_TYPES, PLATFORM, PRESETS, DEFAULT_PRESET, SENSOR_TYPES, TIMING_FIELDS,
  SHAPES, RESOLUTIONS, DYNAMIC_RANGES, RATINGS,
  applyPreset, availableMediaTypes, defaultSelection, creditsMode, describeFacts, groupIntact, groupPreset, hasMediaConditions, presetsInUse, libraryRef, needsPlexPass, presetSensors, sensorId, usesCredits,
  reconcileSelection, reconcileSensors, newChildBridge, newSensor, playerRef, setTiming, summarize, timingValue,
} from './model.js';

const root = document.getElementById('intermission');
const POLL_MS = 2000;

const state = {
  config: undefined,
  status: { signedIn: false },
  view: 'loading',
  tab: 'sensors',
  servers: [],
  chosenServers: [],
  discovery: undefined,
  selection: undefined,
  template: DEFAULT_PRESET,
  signIn: undefined,
  editing: undefined,
  /** An action waiting for a second tap, such as `delete:<id>` or `signout`. */
  confirming: undefined,
  webhook: undefined,
  /** Planned webhook changes: whether to add Intermission's, and URLs marked for removal. */
  webhookPlan: { add: true, remove: [] },
  about: undefined,
  bugHelp: false,
  report: '',
  busy: '',
  error: '',
  /** Changes made on this page that Homebridge's Save has not stored yet. */
  dirty: false,
  /** Whether the running plugin uses the saved settings; see /runtime. */
  runtime: undefined,
  /** A preset waiting for "Add alongside" or "Replace" when sensors already exist. */
  presetChoice: undefined,
  /** Whether the preset list under the Sensors tab is open. */
  presetPicker: false,
  /** What is playing now, for media conditions; per sensor being edited. */
  nowPlaying: undefined,
  /** Setup's choice to run on Intermission's own child bridge (on by default). */
  useChildBridge: true,
  /** Pairing details of the child bridge, once Homebridge has started it. */
  pairing: undefined,
};

/** A child bridge is offered only at first setup: moving existing sensors would re-create them in Apple Home. */
const offerChildBridge = () => !state.config._bridge && state.config.sensors.length === 0;

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c]);
const pressed = (on) => `aria-pressed="${on ? 'true' : 'false'}"`;

async function request(path, body) {
  try {
    return await homebridge.request(path, body);
  } catch (error) {
    throw new Error(error?.message ?? 'Something went wrong talking to Homebridge.', { cause: error });
  }
}

/* ---------- config ---------- */

async function saveConfig({ persist = false } = {}) {
  await homebridge.updatePluginConfig([state.config]);
  if (persist) {
    await homebridge.savePluginConfig();
    state.dirty = false;
    await checkRuntime();
  } else {
    state.dirty = true;
  }
}

/** Asks whether the running plugin uses the saved settings (compared by fingerprint). */
async function checkRuntime(config = state.config) {
  try {
    state.runtime = await request('/runtime', { config: structuredClone(config) });
  } catch {
    state.runtime = undefined;
  }
}

/** Saved settings that the running plugin does not use yet. */
const needsRestart = () => state.runtime !== undefined && !state.runtime.current;

/** The servers being set up (during setup) or saved. Setup commits its choice only when it finishes. */
const servers = () => state.setupServers ?? state.config.servers ?? [];
const savedServerIds = () => (state.config.servers ?? []).map((s) => s.id);
const selection = () => state.config.selection ?? { players: [], allUsers: true, users: [], libraries: [] };
const webhookBody = () => ({ config: state.config, servers: servers() });

/* ---------- flow ---------- */

async function applyTheme() {
  let mode;
  try {
    mode = await homebridge.userCurrentLightingMode?.();
  } catch {
    // Older Homebridge UI: fall back to the system setting.
  }
  mode ??= window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  root.dataset.theme = mode;
}

async function start() {
  homebridge.hideSchemaForm();
  await applyTheme();
  const configs = await homebridge.getPluginConfig();
  // Fingerprinted before anything below adjusts it, so it matches what the plugin loaded.
  await checkRuntime(configs[0] ?? {});
  state.config = configs[0] ?? { platform: PLATFORM, name: 'Intermission' };
  state.config.sensors ??= [];
  if (state.config.server && !state.config.servers) {
    state.config.servers = [state.config.server];
    delete state.config.server;
  }
  try {
    state.status = await request('/status', { setupId: state.config.setupId });
  } catch (error) {
    state.error = error.message;
  }
  request('/about').then((about) => {
    state.about = about;
    render();
  }, () => {});
  route();
}

function route() {
  if (!state.status.signedIn) {
    go('signin');
  } else if (servers().length === 0) {
    void loadServers();
  } else if (state.config.sensors.length === 0 && !state.config.selection) {
    void loadDiscovery('choose');
  } else {
    go('main');
    void loadMain();
  }
}

function go(view) {
  state.view = view;
  state.busy = '';
  state.confirming = undefined;
  // Homebridge's own Save would store a half-finished setup, so it waits until setup is done.
  if (view === 'main') {
    homebridge.enableSaveButton?.();
  } else {
    homebridge.disableSaveButton?.();
  }
  render();
}

async function busy(label, task) {
  state.busy = label;
  state.error = '';
  render();
  try {
    await task();
  } catch (error) {
    state.error = error.message;
  } finally {
    state.busy = '';
    render();
  }
}

async function loadMain() {
  if (!state.discovery) {
    try {
      state.discovery = await request('/discover', { servers: servers() });
    } catch {
      // The board still works from the saved choices.
    }
  }
  await Promise.all([refreshWebhook(), refreshPairing()]);
  render();
}

/** Reads the child bridge's pairing state, so the page can show its code until it's in the Home app. */
async function refreshPairing() {
  const username = state.config._bridge?.username;
  if (!username) {
    state.pairing = undefined;
    return;
  }
  try {
    state.pairing = await request('/bridge/pairing', { username });
  } catch {
    state.pairing = undefined;
  }
}

/** Shown at the top of Sensors until Intermission's bridge is added to the Home app. */
function pairingCard() {
  const p = state.pairing;
  if (!state.config._bridge || !p || p.paired) {
    return '';
  }
  if (!p.published || !p.setupURI) {
    return needsRestart() || state.dirty ? '' : `<div class="im-card im-banner mb-3"><strong class="im-banner-title">Add Intermission to the Home app</strong>
      <span>Intermission runs on its own bridge. Its pairing code appears here once Homebridge has restarted.</span>
      <div class="mt-2"><button class="btn btn-sm btn-outline-secondary" data-action="recheck-pairing">Check again</button></div></div>`;
  }
  return `<div class="im-card im-pairing mb-3">
      <div class="im-qr" aria-label="HomeKit pairing code">${p.qrSvg ?? ''}</div>
      <div><strong class="im-banner-title">Add Intermission to the Home app</strong>
        <ol class="small mb-2 mt-1">
          <li>In the Home app, tap <strong>+</strong>, then <strong>Add Accessory</strong>.</li>
          <li>Scan this code with your iPhone or iPad.</li>
          <li>Or tap <strong>More options</strong>, choose <strong>Intermission</strong>, and enter <strong class="im-pin">${escape(p.pincode)}</strong>.</li>
        </ol>
        <p class="im-hint mt-0 mb-2">Intermission runs on its own bridge, so a restart or a problem never touches your other Homebridge accessories. It's added once; your sensors then appear in Apple Home.</p>
        <button class="btn btn-sm btn-outline-secondary" data-action="recheck-pairing">I've added it</button></div>
    </div>`;
}

async function refreshWebhook(rethrow = false) {
  try {
    state.webhook = await request('/webhook/status', webhookBody());
    state.webhookPlan = { add: !state.webhook.registered, remove: [...(state.webhook.stale ?? [])] };
  } catch (error) {
    state.webhook = { error: error.message };
    if (rethrow) {
      throw error;
    }
  }
}

/** Applies the planned webhook changes. Returns true when there was nothing to do or it worked. */
async function applyWebhookPlan() {
  const hook = state.webhook;
  const plan = state.webhookPlan;
  const adding = plan.add && !hook.registered;
  const fixing = plan.add && hook.disabledOn.length > 0;
  if (!adding && !fixing && plan.remove.length === 0) {
    return true;
  }
  await busy('Updating your Plex webhooks…', async () => {
    state.webhook = await request('/webhook/update', { ...webhookBody(), add: plan.add || hook.registered, remove: plan.remove });
    state.webhookPlan = { add: !state.webhook.registered, remove: [] };
    homebridge.toast.success(state.webhook.registered ? 'Plex will send events to Intermission.' : 'Webhooks updated.', 'Plex webhooks');
  });
  return !state.error;
}

async function beginSignIn(mode) {
  // Open the window inside the click so pop-up blockers allow it, then point it at Plex.
  const popup = mode === 'browser' ? window.open('', 'plex-sign-in', 'width=720,height=760') : null;
  await busy('Contacting Plex…', async () => {
    const result = await request('/signin/start', { mode });
    state.signIn = { mode, ...result };
    if (popup && result.authUrl) {
      popup.location.href = result.authUrl;
    }
    pollSignIn(popup);
  });
}

function pollSignIn(popup) {
  clearTimeout(state.signIn?.timer);
  const tick = async () => {
    if (state.view !== 'signin' || !state.signIn) {
      return;
    }
    try {
      const result = await request('/signin/check');
      if (result.done) {
        popup?.close();
        state.signIn = undefined;
        state.status = { signedIn: true, username: result.username, plexPass: result.plexPass };
        // The sign-in belongs to this config; a reinstall without it starts fresh.
        state.config.setupId = result.setupId;
        await saveConfig({ persist: true });
        homebridge.toast.success(`Signed in as ${result.username}.`, 'Plex');
        route();
        return;
      }
      if (result.expired) {
        state.signIn = undefined;
        state.error = 'The sign-in took too long. Please try again.';
        render();
        return;
      }
    } catch (error) {
      state.error = error.message;
      render();
    }
    state.signIn.timer = setTimeout(tick, POLL_MS);
  };
  state.signIn.timer = setTimeout(tick, POLL_MS);
}

async function loadServers() {
  go('server');
  await busy('Finding your Plex servers…', async () => {
    state.servers = await request('/servers');
    const saved = savedServerIds().filter((id) => state.servers.some((s) => s.id === id));
    const owned = state.servers.filter((s) => s.owned);
    // Changing servers later starts from the current choice; a first setup from the servers you own.
    state.chosenServers = saved.length > 0 ? saved : (owned.length > 0 ? owned : state.servers).map((s) => s.id);
  });
  if (state.servers.length === 1 && !state.error) {
    await useServers();
  }
}

async function useServers() {
  const names = state.servers.filter((s) => state.chosenServers.includes(s.id)).map((s) => s.name).join(' and ');
  await busy(`Finding the best way to reach ${names}…`, async () => {
    const result = await request('/servers/select', { ids: state.chosenServers });
    if (result.servers.length === 0) {
      throw new Error(result.failed.map((f) => `${f.name}: ${f.error}`).join(' ') || 'No server could be reached.');
    }
    for (const failure of result.failed) {
      homebridge.toast.warning?.(`${failure.name}: ${failure.error}`, 'Skipped');
    }
    state.setupServers = result.servers;
  });
  if (!state.error) {
    await loadWebhookStep();
  }
}

async function loadWebhookStep() {
  go('webhooks');
  await busy('Checking Plex Pass and webhooks…', async () => {
    await refreshWebhook(true);
  });
}

async function loadDiscovery(next, { keepSelection = false } = {}) {
  // Refresh keeps what was picked on this page; otherwise start from the saved choices.
  const current = keepSelection ? state.selection : undefined;
  const currentServers = keepSelection ? servers().map((s) => s.id) : savedServerIds();
  state.discovery = undefined;
  state.selection = undefined;
  go(next);
  await busy('Looking for your players, people and libraries…', async () => {
    state.discovery = await request('/discover', { servers: servers() });
    const base = current ?? state.config.selection;
    state.selection = base
      ? reconcileSelection(structuredClone(base), state.discovery, currentServers)
      : defaultSelection(state.discovery);
    state.selection.allUsers ??= state.selection.users.length === 0;
  });
}

async function finishSetup() {
  if (state.setupServers) {
    if (state.config.sensors.length > 0) {
      state.config.sensors = reconcileSensors(state.config.sensors, state.discovery, savedServerIds(), state.config.selection?.libraries ?? []);
    }
    state.config.servers = state.setupServers;
    state.setupServers = undefined;
  }
  state.config.selection = state.selection;
  if (offerChildBridge() && state.useChildBridge) {
    state.config._bridge = newChildBridge();
  }
  if (state.template !== 'scratch' && state.config.sensors.length === 0) {
    state.config.sensors = presetSensors(state.template, state.selection);
    state.config.preset = state.template;
  }
  await busy('Saving…', () => saveConfig({ persist: true }));
  if (!state.error) {
    homebridge.toast.success('Restart Homebridge (or this plugin\'s child bridge) to add the sensors to Apple Home.', 'Saved');
    state.tab = 'sensors';
    go('main');
    void loadMain();
  }
}

async function refreshFromPlex() {
  await busy('Refreshing from Plex…', async () => {
    state.status = await request('/status', { setupId: state.config.setupId });
    state.discovery = await request('/discover', { servers: servers() });
    await refreshWebhook();
    if (state.tab === 'advanced' && state.report) {
      state.report = await request('/diagnostics', { ...reportBody(), includeNames: state.includeNames === true });
    }
  });
}

function reportBody() {
  const env = homebridge.serverEnv?.env ?? {};
  return {
    ...webhookBody(),
    homebridgeVersion: `${env.packageVersion ?? '?'}${env.runningInDocker ? ', Docker' : ''}`,
  };
}

/* ---------- views ---------- */

function render() {
  const views = { loading, signin, server, webhooks, choose, template, main };
  try {
    root.innerHTML = `${(views[state.view] ?? loading)()}${footer()}`;
  } catch (error) {
    // Never leave a blank page: show what went wrong with a way back.
    root.innerHTML = `<div class="im-alert im-alert-danger">Something went wrong showing this page: ${escape(error.message)}</div>
      <button class="btn btn-outline-secondary" data-action="reload">Reload</button>${footer()}`;
  }
  homebridge.fixScrollHeight?.();
}

function loading() {
  return '<div class="im-hero"><img src="icon.svg" alt=""><p class="im-lead">Loading Intermission…</p></div>';
}

function notices() {
  return `${state.busy ? `<div class="im-card text-center"><span class="spinner-border spinner-border-sm me-2"></span>${escape(state.busy)}</div>` : ''}
    ${state.error ? `<div class="im-alert im-alert-danger" role="alert">${escape(state.error)}</div>` : ''}`;
}

function signin() {
  const pending = state.signIn;
  const expired = state.status.expired ? '<div class="im-alert">Plex no longer accepts the saved sign-in. Please sign in again.</div>' : '';
  let body;
  if (pending?.mode === 'code') {
    body = `<p class="im-lead">Go to <a href="${escape(pending.linkUrl)}" target="_blank" rel="noopener">plex.tv/link</a> on any device and enter this code:</p>
      <p class="im-code">${escape(pending.code)}</p>
      <p class="im-muted"><span class="spinner-border spinner-border-sm me-2"></span>Waiting for Plex…</p>`;
  } else if (pending) {
    body = `<p class="im-lead">Finish signing in in the Plex window. This page continues on its own.</p>
      <p class="im-muted"><span class="spinner-border spinner-border-sm me-2"></span>Waiting for Plex…</p>
      <p><a href="${escape(pending.authUrl)}" target="_blank" rel="noopener">Open the Plex sign-in page</a> if no window appeared.</p>`;
  } else {
    body = `<p class="im-lead">Turn Plex playback into Apple Home sensors: lights down when something starts playing, up slowly when the credits roll, quicker when you pause.</p>
      <button class="btn btn-im btn-lg" data-action="signin-browser" ${state.busy ? 'disabled' : ''}>Sign in with Plex</button>
      <p class="mt-3"><button class="im-link" data-action="signin-code">Use a code instead</button></p>`;
  }
  return `<div class="im-hero"><img src="icon.svg" alt=""><h4 class="mt-2">Intermission for Plex</h4>${expired}${body}</div>
    ${notices()}
    <p class="text-center im-muted small">Your Plex sign-in stays on this Homebridge, readable only by Homebridge.</p>`;
}

function stepHeader(number, title) {
  return `<div class="im-step mt-2">Step ${number} of 4</div><h5 class="mb-3">${title}</h5>`;
}

function server() {
  if (state.busy) {
    return `${stepHeader(1, 'Choose your Plex servers')}${notices()}`;
  }
  const list = state.servers.map((s) => `<button class="im-pick" data-action="toggle-server" data-id="${escape(s.id)}" ${pressed(state.chosenServers.includes(s.id))}>
      ${deviceIcon({ product: 'Plex Media Server' })}<strong>${escape(s.name)}</strong><small>${s.owned ? 'Your server' : 'Shared with you'}</small>
    </button>`).join('');
  return `${stepHeader(1, 'Choose your Plex servers')}${notices()}
    <p class="im-muted small">Intermission watches playback on every server you choose.</p>
    ${state.servers.length === 0 ? '<p class="im-muted">No servers found on this Plex account.</p>' : `<div class="im-grid mb-3">${list}</div>`}
    <div class="d-flex gap-2">
      ${state.servers.length > 0 ? `<button class="btn btn-im" data-action="use-servers" ${state.chosenServers.length === 0 ? 'disabled' : ''}>Next</button>` : ''}
      ${state.error ? '<button class="btn btn-outline-secondary" data-action="reload-servers">Try again</button>' : ''}
      ${cancelSetup()}
    </div>`;
}

/** Changing servers later can be abandoned; nothing is saved until the last step. */
function cancelSetup() {
  return savedServerIds().length > 0 && state.config.sensors.length > 0
    ? '<button class="btn btn-outline-secondary ms-auto" data-action="cancel-setup">Cancel</button>' : '';
}

function section(title, help, body) {
  return `<section class="im-section"><header><h6>${title}</h6><p>${help}</p></header>${body}</section>`;
}

function choose() {
  if (state.busy || !state.discovery || !state.selection) {
    return `${stepHeader(3, 'Choose what Intermission watches')}${notices()}`;
  }
  const sel = state.selection;
  const allPlayers = `<button class="im-pick" data-action="players-all" ${pressed(sel.allPlayers)}>
      ${DEVICE_ICONS.default.svg}<strong>All players</strong><small>Any device on your account</small></button>`;
  const players = allPlayers + state.discovery.players.map((p) => `<button class="im-pick" data-action="toggle-player" data-id="${escape(p.id)}" ${pressed(!sel.allPlayers && sel.players.some((s) => s.id === p.id))}>
      ${deviceIcon(p)}<strong>${escape(p.name)}</strong>
      <small>${escape([p.product, p.plays ? `${p.plays} ${p.plays === 1 ? 'play' : 'plays'}` : ''].filter(Boolean).join(' · '))}</small>
      ${p.playingNow ? '<span class="im-live">● Playing now</span>' : ''}
    </button>`).join('');
  return `${stepHeader(3, 'Choose what Intermission watches')}${notices()}
    ${section('Players', 'The players in the room with the lights. Most used first. Choose at least one, or All players.',
      `<div class="im-grid">${players || '<p class="im-muted">No players found yet. Play something on the TV, then Refresh.</p>'}</div>`)}
    ${section('People', 'Whose playback should change the lights.', peoplePicker(sel))}
    ${section('Libraries', 'Movies and TV Shows are chosen for you. They get credits and intro handling; other libraries and Live TV just follow play, pause and stop.', libraryPicker(sel))}
    <div class="d-flex gap-2">
      <button class="btn btn-im" data-action="to-template" ${(sel.allUsers === false && sel.users.length === 0) || (!sel.allPlayers && sel.players.length === 0) || (!sel.allLibraries && sel.libraries.length === 0) ? 'disabled' : ''}>Next</button>
      <button class="btn btn-outline-secondary" data-action="refresh-choose">Refresh</button>
      ${cancelSetup()}
    </div>`;
}

function peoplePicker(sel) {
  const users = state.discovery.users;
  const some = sel.allUsers === false;
  const list = users.map((u) => `<label class="im-row">
      <input type="checkbox" class="form-check-input" data-user="${escape(u.name)}" ${sel.users.includes(u.name) ? 'checked' : ''}>
      <span class="im-row-icon">${PEOPLE_ICONS.person}</span>
      <span class="im-row-text">${escape(u.name)}${u.admin ? ' <span class="im-badge">Owner</span>' : ''}${u.managed ? ' <span class="im-badge">Managed</span>' : ''}</span>
    </label>`).join('');
  return `<div class="im-options">
      <button class="im-option" data-action="users-all" ${pressed(!some)}>
        <span class="im-row-icon">${PEOPLE_ICONS.everyone}</span>
        <span><strong>All Plex Home users</strong><small>Anyone who plays on the chosen players.</small></span>
      </button>
      <button class="im-option" data-action="users-some" ${pressed(some)} ${users.length === 0 ? 'disabled' : ''}>
        <span class="im-row-icon">${PEOPLE_ICONS.person}</span>
        <span><strong>Select specific Plex users</strong><small>${users.length === 0 ? 'No Plex Home users found on this account.' : 'Only the people you tick.'}</small></span>
      </button>
    </div>
    ${some ? `<div class="im-rows mt-2">${list}</div>${sel.users.length === 0 ? '<p class="im-hint">Tick at least one person.</p>' : ''}` : ''}`;
}

function libraryPicker(sel) {
  const many = state.discovery.servers.length > 1;
  const all = `<div class="im-grid mb-3"><button class="im-pick" data-action="libraries-all" ${pressed(sel.allLibraries)}>
      ${LIBRARY_ICONS.movie}<strong>All libraries</strong><small>${many ? 'On every server, including ones added later' : 'Including ones added later'}</small></button></div>`;
  return all + state.discovery.servers.map((srv) => {
    const cards = srv.libraries.map((l) => `<button class="im-pick" data-action="toggle-library" data-id="${escape(l.key)}" ${pressed(!sel.allLibraries && sel.libraries.some((s) => s.key === l.key))}>
        ${LIBRARY_ICONS[l.kind] ?? LIBRARY_ICONS.other}<strong>${escape(l.title)}</strong>${(LIBRARY_KINDS[l.kind]?.label ?? 'Library') === l.title ? '' : `<small>${LIBRARY_KINDS[l.kind]?.label ?? 'Library'}</small>`}
      </button>`).join('');
    const body = srv.error
      ? `<p class="im-hint">Could not read libraries: ${escape(srv.error)}</p>`
      : `<div class="im-grid">${cards || '<p class="im-muted">No libraries.</p>'}</div>`;
    return many ? `<div class="im-subsection"><div class="im-subhead">${deviceIcon({ product: 'Plex Media Server' })}${escape(srv.name)}</div>${body}</div>` : body;
  }).join('');
}

function template() {
  const cards = PRESETS.map((preset, index) => {
    const items = preset.sensors.map((sensor) => `<li><span class="im-row-icon im-small">${SENSOR_ICONS[sensor.type]}</span><span><strong>${escape(sensor.name)}</strong>
      <br><span class="im-muted">${escape(sensor.why)}</span></span></li>`).join('');
    return `<button class="im-card im-template" data-action="pick-template" data-id="${preset.id}" ${pressed(state.template === preset.id)}>
      <span class="im-step">Preset ${index + 1}</span>
      <div><strong>${escape(preset.name)}</strong>
        <span class="im-badge ms-1">${preset.creditsAware ? 'Credits-Aware' : 'No credits handling'}</span>${preset.recommended ? ' <span class="im-badge on">Recommended</span>' : ''}
        <span class="im-muted"> · ${escape(preset.tagline)}</span></div>
      <p class="im-muted mb-2 mt-1">${escape(preset.about)}</p>
      <ul class="im-preset">${items}</ul>
    </button>`;
  }).join('');
  return `${stepHeader(4, 'Choose a preset')}${notices()}
    <p class="im-muted small">A preset is a starting set of sensors. Each uses sensors, which Apple Home can always read, so a missed update corrects itself. You can edit everything later, or add another preset from the Sensors tab.</p>
    ${cards}
    <p class="small mt-1"><button class="im-link" data-action="pick-template" data-id="scratch">${state.template === 'scratch' ? '✓ ' : ''}Start from scratch instead</button></p>
    ${offerChildBridge() ? `<label class="im-row im-bridge-choice mt-3"><input type="checkbox" class="form-check-input" data-child-bridge ${state.useChildBridge ? 'checked' : ''}>
      <span><strong>Run Intermission on its own bridge</strong> <span class="im-badge on">Recommended</span>
        <small class="d-block im-muted">A restart or a problem in Intermission never touches your other Homebridge accessories, and Intermission can restart on its own. After the restart, you add it to the Home app once with its own code, shown on the Sensors tab. Best decided now: moving it later re-creates its sensors in Apple Home.</small></span></label>` : ''}
    <div class="d-flex gap-2 mt-2">
      <button class="btn btn-im" data-action="finish" ${state.busy ? 'disabled' : ''}>${state.template === 'scratch' ? 'Finish' : 'Create sensors'}</button>
      <button class="btn btn-outline-secondary" data-action="back-choose">Back</button>
    </div>`;
}

function main() {
  const tabs = { sensors: 'Sensors', recipes: 'Guide', advanced: 'Settings' };
  const nav = Object.entries(tabs).map(([id, label]) => `<button class="im-tab" role="tab" aria-selected="${state.tab === id}" data-action="tab" data-id="${id}">${label}</button>`).join('');
  const content = { sensors: sensorsTab, recipes: recipesTab, advanced: advancedTab }[state.tab]();
  const pass = state.status.plexPass === undefined ? ''
    : `<button class="im-badge ${state.status.plexPass ? 'on' : ''}" data-action="open-webhooks" title="Plex Pass and webhooks">${state.status.plexPass ? 'Plex Pass' : 'No Plex Pass'}</button>`;
  return `<div class="im-header">
      <img src="icon.svg" alt="">
      <div class="im-who"><strong>${escape(servers().map((s) => s.name).join(', ') || 'Plex')}</strong><br>
        <small>Signed in as ${escape(state.status.username ?? 'Plex user')}</small></div>
      ${pass}
      <button class="btn btn-sm btn-outline-secondary" data-action="refresh" ${state.busy ? 'disabled' : ''}>Refresh from Plex</button>
    </div>
    ${state.status.signedIn ? '' : '<div class="im-alert">Signed out. <button class="im-link" data-action="to-signin">Sign in again</button></div>'}
    ${notices()}
    ${restartBanner()}
    ${plexPassChangeBanner()}
    <div class="im-tabs" role="tablist">${nav}</div>${content}`;
}

/** Says plainly when settings are not in use yet: unsaved, or saved and waiting for a restart. */
function restartBanner() {
  if (state.dirty) {
    return `<div class="im-card im-banner im-banner-info mb-3"><strong class="im-banner-title">You have unsaved changes.</strong>
      <span>Click <strong>Save</strong> below, then restart Homebridge to apply them.</span></div>`;
  }
  if (!needsRestart()) {
    return '';
  }
  return state.runtime.running
    ? `<div class="im-card im-banner im-banner-info mb-3"><strong class="im-banner-title">Restart Homebridge to apply your saved settings.</strong>
        <span>Intermission keeps using the previous settings until then.</span></div>`
    : `<div class="im-card im-banner im-banner-info mb-3"><strong class="im-banner-title">Intermission is set up.</strong>
        <span>Restart Homebridge to start it. ${state.config._bridge
          ? 'Then add it to the Home app with the code that appears on the Sensors tab.'
          : 'Your sensors appear in Apple Home after the restart.'}</span></div>`;
}

function plexPassChangeBanner() {
  const change = state.status.plexPassChange;
  if (!change) {
    return '';
  }
  const when = new Date(change.changedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const hook = state.webhook;
  const ready = hook && !hook.error && hook.registered && hook.disabledOn.length === 0 && hook.portState !== 'other';
  return change.active
    ? `<div class="im-card im-banner mb-3"><strong>Plex Pass detected (${escape(when)}).</strong>
        ${!hook ? 'Checking your webhooks…'
          : ready ? 'Your Intermission webhook is already set up, so instant play detection and the Plex Pass events are back. New media gets credits markers again.'
          : hook.registered ? 'Your Intermission webhook is registered, but something needs attention before Plex can use it.'
          : 'Add the Intermission webhook for instant play detection and the Plex Pass events. New media gets credits markers again.'}
        <div class="d-flex gap-2 mt-2">${ready ? '' : '<button class="btn btn-sm btn-im" data-action="open-webhooks">Set up webhooks</button>'}
        <button class="btn btn-sm btn-outline-secondary" data-action="ack-plexpass">${ready ? 'OK' : 'Dismiss'}</button></div></div>`
    : `<div class="im-card im-banner mb-3"><strong>Plex Pass ended (detected ${escape(when)}).</strong>
        Intermission switched to basic playback detection on its own; your sensors keep working.
        <div class="mt-2">${noPlexPassSummary()}</div>
        ${state.config.sensors.some((s) => needsPlexPass(s)) ? '<p class="small mb-1">Buttons that only use Plex Pass events are marked "Needs Plex Pass" and won\'t press until Plex Pass returns.</p>' : ''}
        <div class="d-flex gap-2 mt-2"><button class="btn btn-sm btn-outline-secondary" data-action="recheck-plexpass">Check again</button>
        <button class="btn btn-sm btn-outline-secondary" data-action="ack-plexpass">Dismiss</button></div></div>`;
}

function sensorCard(sensor, index, sel) {
  const type = SENSOR_TYPES[sensor.type] ?? SENSOR_TYPES.occupancy;
  const badge = needsPlexPass(sensor) && state.status.plexPass === false ? '<span class="im-badge ms-2">Needs Plex Pass</span>' : '';
  const open = state.editing === sensor.id;
  return `<div class="im-card im-sensor" draggable="${open ? 'false' : 'true'}" data-index="${index}">
    <div class="im-kind" aria-hidden="true">${SENSOR_ICONS[sensor.type] ?? SENSOR_ICONS.occupancy}</div>
    <div class="im-body">
      <div class="d-flex align-items-center flex-wrap gap-1">
        <strong>${escape(sensor.name)}</strong><span class="im-muted small ms-2">${escape(type.label)}</span>${badge}
        <span class="ms-auto"><button class="btn btn-sm im-link" data-action="edit" data-id="${escape(sensor.id)}">${open ? 'Done' : 'Edit'}</button></span>
      </div>
      <div class="im-summary">${escape(summarize(sensor, { ...sel, libraries: knownLibraries() }))}</div>
      ${open ? editor(sensor, sel) : ''}
    </div>
  </div>`;
}

/** Sensors in display order, with each preset group (Every State) gathered under one header. */
function sensorsTab() {
  const sel = selection();
  const sensors = state.config.sensors;
  const shown = new Set();
  const parts = [];
  sensors.forEach((sensor, index) => {
    if (shown.has(sensor.group)) {
      return;
    }
    if (!sensor.group) {
      parts.push(sensorCard(sensor, index, sel));
      return;
    }
    shown.add(sensor.group);
    const members = sensors.map((s, i) => [s, i]).filter(([s]) => s.group === sensor.group);
    const preset = PRESETS.find((p) => p.id === groupPreset(sensor.group));
    const removing = state.confirming === `group:${sensor.group}`;
    parts.push(`<div class="im-group">
      <div class="im-group-head"><span><strong>${escape(preset?.name ?? 'Preset')}</strong><small>${escape(preset?.tagline ?? '')}</small></span>
        <button class="btn btn-sm ${removing ? 'btn-danger' : 'im-link'} ms-auto" data-action="remove-group" data-id="${escape(sensor.group)}">${removing ? `Tap again to remove ${members.length} sensors` : 'Remove set'}</button>
        ${removing ? '<button class="btn btn-sm btn-outline-secondary" data-action="cancel-confirm">Keep them</button>' : ''}</div>
      ${groupIntact(members.map(([s]) => s)) ? '' : '<p class="im-hint mt-0 mb-2">These sensors were edited, so more than one may be on at once, or none. Every State works best with the four states unchanged and the same players, people and libraries on each.</p>'}
      ${members.map(([s, i]) => sensorCard(s, i, sel)).join('')}
    </div>`);
  });
  return `${pairingCard()}${webhookNotice()}
    ${parts.join('') || '<p class="im-muted">No sensors yet. Add a preset, or a sensor of your own.</p>'}
    <div class="d-flex flex-wrap gap-2 mt-2">
      <button class="btn btn-im" data-action="add" data-type="occupancy">Add sensor</button>
      <button class="btn btn-outline-secondary" data-action="add" data-type="button">Add button</button>
      <button class="btn btn-outline-secondary im-btn-preset ms-sm-auto" data-action="toggle-presets" aria-expanded="${state.presetPicker || state.presetChoice ? 'true' : 'false'}">Add preset</button>
    </div>
    ${presetPanel()}
    <p class="im-muted small mt-3">Drag cards to reorder. Changes apply after you press Save and restart Homebridge. Renaming keeps your Home automations.</p>`;
}

/** The preset list, and the "Add alongside / Replace" choice when sensors already exist. */
function presetPanel() {
  const count = state.config.sensors.length;
  if (state.presetChoice) {
    const preset = PRESETS.find((p) => p.id === state.presetChoice);
    const replacing = state.confirming === 'preset-replace';
    return `<div class="im-card im-banner mt-2" id="im-preset-choice"><strong>Add ${escape(preset.name)}</strong>
      <p class="small mb-2 mt-1">You have ${count} ${count === 1 ? 'sensor' : 'sensors'}. Add the preset alongside them, or replace them?
        ${replacing ? `<br><strong>Replacing removes ${count === 1 ? 'your sensor' : `your ${count} sensors`}. Home automations that use them stop working.</strong> A preset sensor with the same name as one of yours keeps that sensor's automations.` : ''}</p>
      <div class="d-flex flex-wrap gap-2">
        <button class="btn btn-sm btn-im" data-action="preset-alongside">Add alongside</button>
        <button class="btn btn-sm ${replacing ? 'btn-danger' : 'btn-outline-danger'}" data-action="preset-replace">${replacing ? 'Tap again to replace' : 'Replace them'}</button>
        <button class="btn btn-sm btn-outline-secondary" data-action="cancel-preset">Cancel</button>
      </div></div>`;
  }
  if (!state.presetPicker) {
    return '';
  }
  return `<div class="im-card mt-2"><strong>Add a preset</strong>
    <p class="im-hint mt-1">The Guide explains each preset and the Home automations to make for it.</p>
    ${PRESETS.map((p) => `<div class="im-preset-row">
      <span><strong>${escape(p.name)}</strong>${p.creditsAware ? ' <span class="im-badge">Credits-Aware</span>' : ''}<small>${escape(p.tagline)}</small></span>
      <button class="btn btn-sm btn-outline-secondary" data-action="pick-preset" data-id="${p.id}">Add</button></div>`).join('')}
  </div>`;
}

/** Every library from discovery, falling back to the saved choices. */
function knownLibraries() {
  const found = (state.discovery?.servers ?? []).flatMap((srv) => srv.libraries.map((l) => libraryRef(srv, l)));
  const saved = selection().libraries.filter((l) => !found.some((f) => f.key === l.key));
  return [...found, ...saved];
}

function editor(sensor, sel) {
  const chips = (action, values, chosen, label = (v) => v, disabled = () => false) => values.map((v) => {
    const id = typeof v === 'string' ? v : (v.key ?? v.id);
    return `<button class="im-chip" data-action="${action}" data-id="${escape(id)}" ${pressed(chosen.includes(id))} ${disabled(id) ? 'disabled' : ''}>${escape(label(v))}</button>`;
  }).join('');
  // Filters: "All" is chosen while nothing else is; picking anything else turns it off.
  const filter = (group, values, label, allLabel) => `<div class="im-chips">
      <button class="im-chip im-all" data-action="filter-all" data-id="${group}" ${pressed(sensor.filters[group].length === 0)}>${allLabel}</button>
      ${chips(`toggle-filter-${group}`, values, sensor.filters[group], label)}</div>`;
  const types = Object.entries(SENSOR_TYPES).map(([id, t]) => `<button class="im-option im-type" data-action="set-type" data-id="${id}" ${pressed(sensor.type === id)}>
      <span class="im-row-icon im-small">${SENSOR_ICONS[id]}</span>
      <span><strong>${t.label}</strong>${t.recommended ? ' <span class="im-badge on">Recommended</span>' : ''}<small>${escape(t.help)}</small></span>
    </button>`).join('');
  const conditions = Object.entries(CONDITIONS).map(([id, label]) => `<option value="${id}" ${sensor.state === id ? 'selected' : ''}>${label}</option>`).join('');
  const isState = SENSOR_TYPES[sensor.type]?.state;
  const players = [...sel.players, ...(state.discovery?.players ?? []).filter((p) => !sel.players.some((s) => s.id === p.id)).map(playerRef)];
  const users = [...new Set([...(sel.users ?? []), ...(state.discovery?.users ?? []).map((u) => u.name)])];
  const libraries = knownLibraries();
  const many = new Set(libraries.map((l) => l.serverId)).size > 1;
  const chosenLibraries = sensor.filters.libraries.length > 0 ? libraries.filter((l) => sensor.filters.libraries.includes(l.key)) : libraries;
  const mediaTypes = availableMediaTypes(chosenLibraries);
  const noPass = state.status.plexPass === false;
  const confirming = state.confirming === `delete:${sensor.id}`;
  return `<div class="im-editor" data-sensor="${escape(sensor.id)}">
    <label class="im-label" for="im-name">Name in Apple Home</label>
    <input id="im-name" class="form-control" data-field="name" value="${escape(sensor.name)}" maxlength="64">
    <label class="im-label">Type <span>(not sure? choose Occupancy sensor)</span></label>
    <div class="im-options im-types">${types}</div>
    ${isState
      ? `<label class="im-label" for="im-state">On while</label><select id="im-state" class="form-select" data-field="state">${conditions}</select>
        ${CAN_EXCEPT.includes(sensor.state) ? `<label class="im-label">Except during <span>(the sensor turns off for these)</span></label>
          <div class="im-chips">${Object.entries(EXCEPTIONS).map(([id, e]) => `<button class="im-chip" data-action="toggle-except" data-id="${id}" ${pressed((sensor.except ?? []).includes(id))}>${escape(e.chip)}</button>`).join('')}</div>` : ''}
        ${usesCredits(sensor) ? creditsChoice() : ''}
        ${sensor.state === 'intro' || (sensor.except ?? []).includes('intro') ? `<p class="im-hint">${state.status.plexPass === false
          ? 'Without Plex Pass, only items that already have Plex intro markers have an intro. Plex finds new ones only on servers with Plex Pass.'
          : 'Intros come from Plex\'s intro markers, found on servers with Plex Pass, mostly for TV episodes.'}</p>` : ''}`
      : `<label class="im-label">Pressed when</label><div class="im-chips">${chips('toggle-event', Object.keys(EVENTS), sensor.events ?? [],
        (e) => `${EVENTS[e].label}${EVENTS[e].plexPass ? ' ★' : ''}`, (e) => noPass && EVENTS[e].plexPass)}</div>
        <div class="im-hint">★ needs Plex Pass</div>`}
    <label class="im-label">Players</label>
    ${filter('players', players, (p) => p.name, 'All players')}
    <label class="im-label">People</label>
    ${filter('users', users, (u) => u, 'All Plex Home users')}
    <label class="im-label">Libraries</label>
    ${filter('libraries', libraries, (l) => (many ? `${l.title} · ${l.serverName}` : l.title), 'All libraries')}
    ${sensor.filters.mediaTypes.length > 0 ? `<label class="im-label">Media types <span>(from an older version; libraries now decide this)</span></label>
      ${filter('mediaTypes', mediaTypes, (t) => MEDIA_TYPES[t], 'All media types')}` : ''}
    ${isState ? mediaSection(sensor) : ''}
    ${runCommands(sensor)}
    <p class="im-hint mt-2">Intermission knows each library's type: Movies and TV Shows get credits and intro handling; Music, Photos, Other Videos and Live TV just follow play, pause and stop.</p>
    <div class="d-flex gap-2 mt-3">
      <button class="btn btn-sm ${confirming ? 'btn-danger' : 'btn-outline-danger'}" data-action="delete" data-id="${escape(sensor.id)}">${confirming ? 'Tap again to remove' : `Remove ${sensor.type === 'button' ? 'button' : 'sensor'}`}</button>
      ${confirming ? '<button class="btn btn-sm btn-outline-secondary" data-action="cancel-confirm">Keep it</button>' : ''}
    </div>
  </div>`;
}

/** What counts as the credits, shown where a sensor depends on it. One setting for every sensor. */
function creditsChoice() {
  const mode = creditsMode(state.config.timing);
  return `<label class="im-label">What counts as the credits <span>(shared by all your sensors, also in Settings)</span></label>
    <div class="im-options im-credits">${Object.entries(CREDITS_MODES).map(([id, m]) => `<button class="im-option" data-action="set-credits-mode" data-id="${id}" ${pressed(mode === id)}>
      <span><strong>${escape(m.label)}</strong>${m.default ? ' <span class="im-badge">Default</span>' : ''}<small>${escape(m.help)}</small></span></button>`).join('')}</div>`;
}

/** "Only when the media is…": picture, rating and labels, read when play starts. */
function mediaSection(sensor) {
  const media = sensor.media ?? {};
  const on = hasMediaConditions(sensor);
  const open = state.open?.[`media:${sensor.id}`] ?? on;
  const chips = (group, values, chosen) => Object.entries(values).map(([id, label]) =>
    `<button class="im-chip" data-action="media-toggle" data-group="${group}" data-id="${escape(id)}" ${pressed((chosen ?? []).includes(id))}>${escape(label)}</button>`).join('');
  const any = (group, label) => `<button class="im-chip im-all" data-action="media-any" data-group="${group}" ${pressed(media[group] === undefined || media[group].length === 0)}>${label}</button>`;
  const head = `<button class="im-collapse-head im-media-head" data-action="toggle-open" data-id="media:${escape(sensor.id)}" aria-expanded="${open}">
      <span><strong>Only when the media is…</strong><small>${on ? 'Conditions set. The sensor stays off for media that doesn\'t match.' : 'Optional: picture shape, resolution, HDR, rating or Plex labels.'}</small></span>
      <span class="im-chevron" aria-hidden="true">${open ? '▾' : '▸'}</span></button>`;
  if (!open) {
    return `<div class="im-media">${head}</div>`;
  }
  return `<div class="im-media">${head}
    <label class="im-label">Picture shape</label>
    <div class="im-chips">${any('shape', 'Any shape')}${Object.entries(SHAPES).map(([id, label]) =>
      `<button class="im-chip" data-action="media-shape" data-id="${id}" ${pressed(media.shape === id)}>${escape(label)}</button>`).join('')}</div>
    <label class="im-label">Resolution</label><div class="im-chips">${any('resolution', 'Any')}${chips('resolution', RESOLUTIONS, media.resolution)}</div>
    <label class="im-label">HDR</label><div class="im-chips">${any('dynamicRange', 'Any')}${chips('dynamicRange', DYNAMIC_RANGES, media.dynamicRange)}</div>
    <label class="im-label">Rating</label><div class="im-chips">${any('ratings', 'Any rating')}${chips('ratings', Object.fromEntries([...new Set([...RATINGS, ...(media.ratings ?? [])])].map((r) => [r, r])), media.ratings)}</div>
    <label class="im-label" for="im-labels">Plex labels <span>(the labels you add to items in Plex; any of these, separated by commas; an episode also uses its show's labels)</span></label>
    <input id="im-labels" class="form-control form-control-sm" data-media-labels value="${escape((media.labels ?? []).join(', '))}" placeholder="For example Kids, Date Night">
    <p class="im-hint">Read from the library item when play starts, so transcoding never changes them. Live TV has no details, so a sensor with conditions stays off for it.</p>
    ${nowPlayingPanel(sensor)}
  </div>`;
}

/** What is playing now, with "+ condition" next to each detail. */
function nowPlayingPanel(sensor) {
  const np = state.nowPlaying;
  const button = `<button class="btn btn-sm btn-outline-secondary" data-action="now-playing" ${np?.loading ? 'disabled' : ''}>${np?.items ? 'Check again' : 'Show what\'s playing now'}</button>`;
  if (!np?.items) {
    return `<div class="im-nowplaying"><div class="d-flex align-items-center gap-2"><strong class="small">Now playing</strong><span class="ms-auto">${button}</span></div>
      <p class="im-hint mb-0">${np?.loading ? 'Asking Plex…' : np?.error ? escape(np.error) : 'Play something, then tap the button to see what Plex reports and add it as a condition.'}</p></div>`;
  }
  const media = sensor.media ?? {};
  const add = (group, value, label = value) => {
    const set = group === 'shape' ? media.shape === value : (media[group] ?? []).some((v) => v.toLowerCase() === String(value).toLowerCase());
    return set ? '<span class="im-badge on">Added</span>'
      : `<button class="im-link small" data-action="media-add" data-group="${group}" data-id="${escape(value)}" title="Add ${escape(label)} as a condition">+ condition</button>`;
  };
  const items = np.items.map((item) => {
    const f = describeFacts(item.facts);
    const facts = item.facts;
    const rows = item.live ? '<p class="im-hint mb-0">Live TV: Plex has no picture, rating or label details for it.</p>'
      : !facts ? '<p class="im-hint mb-0">Plex returned no details for this item.</p>'
      : `<dl class="im-facts im-np">
        <dt>Picture shape</dt><dd>${escape(f.shape ?? 'Unknown')} ${f.shapeValue ? add('shape', f.shapeValue, f.shape) : ''}</dd>
        <dt>Resolution</dt><dd>${escape(f.resolution ?? 'Unknown')} ${facts.resolution ? add('resolution', facts.resolution, f.resolution) : ''}</dd>
        <dt>HDR</dt><dd>${escape(f.dynamicRange ?? 'Unknown')} ${facts.dynamicRange ? add('dynamicRange', facts.dynamicRange, f.dynamicRange) : ''}</dd>
        <dt>Rating</dt><dd>${escape(f.rating ?? 'None')} ${f.rating ? add('ratings', f.rating) : ''}</dd>
        <dt>Plex labels</dt><dd>${f.labels.length ? f.labels.map((l) => `${escape(l)} ${add('labels', l)}`).join(' · ') : 'None'}</dd>
      </dl>`;
    return `<div class="im-np-item"><strong>${escape(item.title)}</strong>
      <small class="d-block im-muted">${escape([item.library, item.player, item.user, np.items.some((i) => i.server !== item.server) ? item.server : ''].filter(Boolean).join(' · '))}</small>${rows}</div>`;
  }).join('');
  return `<div class="im-nowplaying"><div class="d-flex align-items-center gap-2"><strong class="small">Now playing</strong><span class="ms-auto">${button}</span></div>
    ${items || '<p class="im-hint mb-0">Nothing is playing on your servers right now.</p>'}</div>`;
}

/** "Run commands" in the sensor editor, only when commands are turned on and at least one exists. */
function runCommands(sensor) {
  const list = state.config.commands?.enabled ? (state.config.commands.list ?? []).filter((c) => c.name && c.command) : [];
  if (list.length === 0) {
    return '';
  }
  const row = (when, label) => `<label class="im-label">${label}</label><div class="im-chips">${list.map((c) =>
    `<button class="im-chip" data-action="toggle-run" data-when="${when}" data-id="${escape(c.id)}" ${pressed((sensor.run?.[when] ?? []).includes(c.id))}>${escape(c.name)}</button>`).join('')}</div>`;
  return `<div class="im-run">${SENSOR_TYPES[sensor.type]?.state
    ? `${row('on', 'Run commands when it turns on')}${row('off', 'Run commands when it turns off')}`
    : row('press', 'Run commands when pressed')}</div>`;
}

function webhookNotice() {
  const hook = state.webhook;
  if (state.status.plexPass !== true || !hook || hook.error || (hook.registered && hook.disabledOn.length === 0 && hook.portState !== 'other')) {
    return '';
  }
  return `<div class="im-card im-banner mb-3">
    <strong>${hook.portState === 'other' ? `Port ${hook.port} is used by another app` : 'Plex webhooks are not set up'}</strong>
    <span class="im-muted">${hook.portState === 'other' ? 'Choose another webhook port.' : 'They make play detection instant and add the Plex Pass events.'}</span>
    <div class="mt-2"><button class="btn btn-sm btn-im" data-action="open-webhooks">Set up</button></div>
  </div>`;
}

const PORT_TEXT = {
  waiting: (port) => `Port ${port} is ready. Intermission starts listening after Homebridge restarts.`,
  free: (port) => `Not listening, although Homebridge is running these settings. Check the Homebridge log for an error about port ${port}.`,
  intermission: (port) => `Intermission is listening on port ${port}.`,
  other: (port) => `Another app is using port ${port}. Choose a different port below, or Plex's webhooks will reach that app instead.`,
  unknown: (port) => `Could not check port ${port}.`,
};

/**
 * The port row: green when Intermission answers, amber while a restart is still to come, red when
 * something is wrong (another app, or the running plugin is not listening).
 */
function portRow(hook) {
  const waiting = hook.portState === 'free' && (state.dirty || needsRestart() || state.view !== 'main' || state.runtime === undefined);
  const key = waiting ? 'waiting' : hook.portState;
  const tone = { waiting: 'warn', intermission: 'ok', other: 'bad', free: 'bad', unknown: 'warn' }[key] ?? '';
  return { key, tone };
}

/** Plex Pass, server settings, the account's webhooks with remove buttons, and Intermission's. */
/** What an account without Plex Pass does not get. Shown only to those accounts. */
function noPlexPassSummary() {
  return `<div class="im-status warn"><span class="im-dot"></span><div>
      <strong>No Plex Pass on this account</strong>
      <small>Intermission works without it. Pause, resume, stop, skips and the credits all work. What you don't get:</small>
      <ul class="small mb-0 mt-1 im-list">
        <li><strong>Instant play:</strong> Plex reports play up to about 10 seconds after you press it, so sensors change a little later. Everything else is instant.</li>
        <li><strong>New credits and intro markers:</strong> Plex only finds credits and intros on servers with Plex Pass. Items that already have markers still use them. Others use 95% of the runtime for the credits, with no mid-credits scenes, and have no intro.</li>
        <li><strong>Plex Pass events:</strong> "Marked as watched", "Rated", "Added to a library" and similar events can't be used on buttons.</li>
      </ul>
    </div></div>`;
}

function webhookPanel() {
  const hook = state.webhook;
  if (!hook) {
    return '<p class="im-muted">Checking…</p>';
  }
  if (hook.error) {
    return `<div class="im-alert im-alert-danger">${escape(hook.error)}</div>`;
  }
  const plan = state.webhookPlan;
  const passRow = hook.plexPass
    ? `<div class="im-status ok"><span class="im-dot"></span><div><strong>Plex Pass is active</strong>
        <small>Webhooks make play detection instant and add events such as "Marked as watched" and "Added to a library".</small></div></div>`
    : noPlexPassSummary();
  if (!hook.plexPass) {
    return passRow;
  }
  const settings = hook.serverSettings.map((srv) => `<div class="im-status ${srv.enabled === false ? 'warn' : srv.enabled ? 'ok' : ''}"><span class="im-dot"></span><div>
      <strong>${escape(srv.name)}: Webhooks setting ${srv.enabled === undefined ? 'unknown' : srv.enabled ? 'on' : 'off'}</strong>
      <small>${srv.enabled === false ? 'Plex sends no webhooks while this is off. It is turned on when you add the Intermission webhook.' : srv.enabled ? 'In Plex: Settings, Network, Webhooks.' : 'Unknown: only the server\'s owner can see this setting.'}</small>
    </div></div>`).join('');
  const portState = portRow(hook);
  const port = `<div class="im-status ${portState.tone}"><span class="im-dot"></span><div>
      <strong>Webhook port ${hook.port}</strong><small>${PORT_TEXT[portState.key]?.(hook.port) ?? ''}</small>
      ${hook.portState === 'other' ? `<div class="input-group input-group-sm mt-1 im-port"><input type="number" class="form-control" min="1024" max="65535" data-webhook-port value="${hook.port + 1}"><button class="btn btn-sm btn-outline-secondary" data-action="recheck-webhooks">Use this port</button></div>` : ''}
    </div></div>`;
  const row = (url, tag, removable) => {
    const removing = plan.remove.includes(url);
    return `<li class="${removing ? 'im-removing' : ''}">
      ${removable ? `<button class="im-minus" data-action="toggle-remove" data-url="${escape(url)}" aria-label="${removing ? 'Keep' : 'Remove'} ${escape(url)}" title="${removing ? 'Keep' : 'Remove'}">${removing ? '↺' : '−'}</button>` : '<span class="im-minus-space"></span>'}
      <code>${escape(url)}</code> ${tag ? `<span class="im-badge">${tag}</span>` : ''}${removing ? ' <span class="im-badge bad">will be removed</span>' : ''}</li>`;
  };
  const existing = [
    ...hook.others.map((url) => row(url, '', true)),
    ...hook.stale.map((url) => row(url, 'old Intermission address', true)),
    ...(hook.registered ? [row(hook.url, 'Intermission ✓', false)] : []),
  ].join('');
  const adding = !hook.registered;
  return `${passRow}${settings}${port}
    <h6 class="mt-3">Webhooks on your Plex account</h6>
    <ul class="im-urls">${existing || '<li class="im-muted">None yet.</li>'}</ul>
    ${adding ? `<label class="im-row im-add">
        <input type="checkbox" class="form-check-input" data-webhook-add ${plan.add ? 'checked' : ''}>
        <span><strong>Add the Intermission webhook</strong><br><code>${escape(hook.url ?? 'No address found. Set one under Advanced.')}</code></span>
      </label>` : ''}
    <p class="im-hint">The last part of the address is a random key made for this Homebridge. Intermission ignores anything sent without it, so stray requests on your network can't set off your lights. Nothing else on your account changes; webhooks you mark with − are removed.</p>`;
}

function webhooks() {
  if (state.busy) {
    return `${stepHeader(2, 'Plex Pass and webhooks')}${notices()}`;
  }
  const hook = state.webhook ?? {};
  const changes = hook.plexPass && !hook.error && ((state.webhookPlan.add && (!hook.registered || hook.disabledOn.length > 0)) || state.webhookPlan.remove.length > 0);
  return `${stepHeader(2, 'Plex Pass and webhooks')}${notices()}
    <section class="im-section">${webhookPanel()}</section>
    <div class="d-flex gap-2">
      <button class="btn btn-im" data-action="webhooks-next">${changes ? 'Apply and continue' : 'Continue'}</button>
      ${changes ? '<button class="btn btn-outline-secondary" data-action="webhooks-skip">Skip for now</button>' : ''}
      ${cancelSetup()}
    </div>`;
}

function recipesTab() {
  const step = (html) => `<li>${html}</li>`;
  const inUse = presetsInUse(state.config.sensors);
  const head = (id, name) => `<div class="im-preset-head mt-4" data-preset="${id}"><h5 class="m-0">${name}${inUse.includes(id) ? ' <span class="im-badge on">In use</span>' : ''}</h5>
    ${inUse.includes(id) ? '' : `<button class="btn btn-sm btn-outline-secondary ms-auto" data-action="pick-preset" data-id="${id}">Add this preset</button>`}</div>`;
  /** One automation: the trigger, then either a plain light setting or a shortcut recipe. */
  const auto = (sensor, when, what, recipe) => `<div class="im-auto">
      <div class="im-auto-when"><span class="im-badge">${when === 'off' ? 'Stops detecting' : 'Detects occupancy'}</span> <strong>${sensor}</strong></div>
      <div class="im-auto-what">${what}</div>${recipe ?? ''}</div>`;
  /**
   * Shortcut steps as the Home app's shortcut editor shows them: [action, detail, indented]. `check`
   * expands to If, Stop this shortcut and End If.
   */
  const recipe = (name, steps, note) => `<div class="im-shortcut"><div class="im-shortcut-name">${name}</div><ol>
      ${steps.flatMap((x) => (Array.isArray(x[0]) ? x : [x])).map(([action, detail, indent]) => `<li><span class="im-sc-action${indent ? ' im-sc-indent' : ''}">${action}</span> ${detail}</li>`).join('')}</ol>${note ? `<p class="im-hint mt-1 mb-0">${note}</p>` : ''}</div>`;
  const set = (level) => ['Set', `your lights to <strong>${level}</strong>`];
  const wait = (seconds = 1) => ['Wait', `${seconds} second${seconds === 1 ? '' : 's'}`];
  const check = (sensor, value) => [
    ['If', `<strong>${sensor}</strong> Occupancy Detected is <strong>${value}</strong>`],
    ['Stop this shortcut', '', true],
    ['End If', ''],
  ];
  const fadeUp = (sensor) => recipe('Gentle fade up (about 3 seconds)', [set('10%'), wait(), check(sensor, 'Yes'), set('18%'), wait(), check(sensor, 'Yes'), set('25%')],
    'The checks stop the fade at once if playback comes back mid-fade, for example a mid-credits scene.');
  const crawl = recipe('Slow crawl (about 7 seconds)', [set('1%'), wait(), set('2%'), wait(), set('3%'), wait(), set('5%'), wait(),
    check('Credits Rolling', 'No'), set('15%'), wait(), set('25%')],
  'Eases eyes up from the dark before the main fade. Add more 1% steps for a longer crawl.');
  const fullHouse = recipe('Full house (about 1 second)', [set('60%'), wait(), set('100%')]);
  const pauseGlow = recipe('Pause glow (about 1 second)', [set('15%'), wait(), set('30%')]);
    const good = `<ul class="small mb-0">
      <li><strong>Why suggest sensors, not buttons?</strong> Home can always read a sensor. If it misses a change (hub restart, Wi-Fi drop, Homebridge restart), it sees the right state when it reconnects. A missed button press is simply gone. Buttons are still available for one-off actions.</li>
      <li>Pauses under 1.5 seconds, skips and quick pause-play bursts don't change any sensor, so lights never stutter. Adjust it in Settings, Advanced, <strong>Pause debounce</strong>.</li>
      <li>Movies and TV Shows get credits and intro handling. Music, Photos, Other Videos and Live TV just follow play, pause and stop.</li>
      <li>What counts as the credits is one setting shared by every sensor, so sensors that follow the credits always agree. By default a mid-credits scene counts as playing.</li>
      <li>A pause during the credits keeps "In the credits" sensors on, so a fade isn't interrupted.</li>
      <li>Stopping partway through counts after 1 second. Autoplaying the next episode isn't a stop: when playback stops in the credits or near the end, sensors wait 10 seconds for the next episode before Nothing Playing turns on. If your player's countdown is longer, raise Settings, Advanced, <strong>Stop hold</strong>.</li>
      <li>After a Homebridge restart, sensors keep their last state until Plex has been read, so lights don't jump.</li>
      <li>Renaming a sensor keeps the automations that use it. If you renamed it in the Home app, Home keeps your name. Removing a sensor removes it from Apple Home.</li>
    </ul>`;
  return `<div class="im-recipe">
    ${collapsible('good-to-know', 'Good to know', 'How Intermission behaves, in a few lines.', good, { defaultOpen: true, extraClass: 'im-callout' })}

    <h4 class="mt-4 mb-1">Making the automations</h4>
    <p class="im-muted small">Intermission makes the sensors; you make the light changes in the Home app. Each preset below lists the automations to make.</p>
    <div class="im-card"><h6>A plain automation</h6><ol>
      ${step('In the Home app, open the <strong>Automation</strong> tab and tap <strong>+</strong>.')}
      ${step('Choose <strong>A Sensor Detects Something</strong>, then your Intermission sensor, for example <strong>Media Playing</strong>.')}
      ${step('Choose <strong>Detects Occupancy</strong> or <strong>Stops Detecting Occupancy</strong>, as the preset says, then <strong>Next</strong>.')}
      ${step('Pick your lights or a scene and set the level. Done.')}</ol>
      ${shots([['when', 'The sensor, Detects Occupancy, then Next', 'Step 3']])}</div>
    <div class="im-card"><h6>A fade, using a shortcut</h6>
      <p class="small im-muted mb-2">Apple Home sets lights in one jump. For a fade, the automation runs a short shortcut that steps the lights up, waiting a second between steps. Most smart dimmers already glide between levels, so 1-second steps look smooth.</p><ol>
      ${step('Make the automation as above. On the screen that lists your lights and scenes, don\'t pick anything.')}
      ${step('Scroll all the way to the bottom, past every room, and tap <strong>Convert To Shortcut</strong>.')}
      ${step('The shortcut starts with one <strong>Set</strong> step. Tap <strong>Scenes and Accessories</strong> in it, pick your lights, then tap each light to set its level.')}
      ${step('Add the rest of the recipe with the search bar at the bottom: <strong>Wait</strong>, <strong>If</strong> (pick your sensor, then <strong>Occupancy Detected</strong>), <strong>Stop this shortcut</strong> and more <strong>Set</strong> steps. Drag steps into order.')}
      ${step('Tap ✓ to save. Change the levels to suit your room; the shape matters more than the exact numbers.')}</ol>
      ${shots([
    ['convert', 'Convert To Shortcut is below the last room', 'Step 2'],
    ['shortcut-new', 'A new shortcut has one Set step', 'Step 3'],
    ['set-lights', 'Your lights in the Set step; tap one to set its level', 'Step 3'],
    ['steps', 'The end of a slow crawl: Wait, If, Stop this shortcut, End If, Set', 'Step 4'],
  ])}</div>

    ${presetSections({
    simple: `
    ${head('simple', 'Simple')}
    <p class="small mt-2">Best for rooms where the lights just go down while anything plays and come back for everything else, including music. Two automations:</p>
    ${auto('Media Playing', 'on', 'Set your lights dim (or a scene), in one jump.')}
    ${auto('Media Playing', 'off', 'Bring the lights back. A fade feels nicer:', fullHouse)}
`,
    credits: `
    ${head('credits', 'Simple + Credits')}
    <p class="small mt-2">Best for most living rooms and theaters. Still one sensor: it also turns off for the credits, and by default on again for a mid-credits scene. Two automations:</p>
    ${auto('Media Playing', 'on', 'Set your lights dim, in one jump, so a mid-credits scene goes dark again at once.')}
    ${auto('Media Playing', 'off', 'Fade up gently. This covers the credits, a pause and the end alike:', fadeUp('Media Playing'))}
`,
    states: `
    ${head('states', 'Every State')}
    <p class="small mt-2">Best when pause, credits and the end should each look different. Exactly one of the four sensors is on at a time, so each gets one "Detects Occupancy" automation, and none needs "Stops detecting":</p>
    ${auto('Media Playing', 'on', 'Lights down, in one jump.')}
    ${auto('Media Paused', 'on', 'A little light, for example just the lamp by the door, or:', pauseGlow)}
    ${auto('Credits Rolling', 'on', 'A slow fade up. A mid-credits scene switches back to Media Playing on its own.', crawl)}
    ${auto('Nothing Playing', 'on', 'Normal lighting.', fullHouse)}
    ${shots([['tiles', 'In the Home app, one of the four is on at a time', 'The sensors'], ['automations', 'The four automations, one per sensor', 'Finished']])}
    <div class="im-card mt-3"><h6>Ideas for Every State</h6><ul class="small mb-0">
      <li>Add a condition such as <strong>only after sunset</strong> so daytime watching leaves the lights alone.</li>
      <li>On <strong>Media Paused</strong>, light the path to the kitchen instead of the whole room.</li>
      <li>Use color: a warm scene for the credits, a dim blue for pause.</li>
      <li>Several light zones: give each its own steps in the same shortcut, for example sconces a step ahead of the overhead lights.</li>
      <li>Go beyond lights: close the shades on Media Playing, open them on Nothing Playing, or switch a fan or soundbar.</li>
      <li>One sensor per room: give each sensor its own player (Edit, Players), for example "Bedroom Playing".</li>
    </ul></div>
`,
  }, inUse)}

    <h4 class="mt-4 mb-1">Beyond the presets</h4>
    <div class="im-card"><ul class="small mb-0">
      <li><strong>Projector masking:</strong> a sensor with "Only when the media is… Wide" turns on only for wide movies. Use it with a command or an automation to switch lens memory.</li>
      <li><strong>Kids watching:</strong> a sensor limited to ratings such as G and PG, or to one Plex Home user, can keep the lights brighter.</li>
      <li><strong>Live TV:</strong> choose Live TV under a sensor's Libraries if the lights should follow it too. It never has credits.</li>
    </ul></div>
  </div>`;
}

/**
 * The Guide's presets: the ones in use first, open; the rest folded into one section. With none in
 * use, all are shown.
 */
function presetSections(sections, inUse) {
  const ids = PRESETS.map((p) => p.id);
  const others = ids.filter((id) => !inUse.includes(id));
  if (inUse.length === 0) {
    return `<h4 class="mt-4 mb-1">Presets</h4>
    <p class="im-muted small">"Add this preset" adds its sensors to the Sensors tab.</p>
    ${ids.map((id) => sections[id]).join('')}`;
  }
  const names = (list) => list.map((id) => PRESETS.find((p) => p.id === id).name).join(', ');
  return `<h4 class="mt-4 mb-1">Your ${inUse.length === 1 ? 'preset' : 'presets'}</h4>
    <p class="im-muted small">The automations to make for the sensors you have.</p>
    ${inUse.map((id) => sections[id]).join('')}
    ${others.length ? `<div class="mt-4">${collapsible('other-presets', 'Other presets', names(others), `<p class="im-muted small mt-2 mb-0">"Add this preset" adds its sensors to the Sensors tab.</p>${others.map((id) => sections[id]).join('')}`)}</div>` : ''}`;
}

/** Guide screenshots of the Home app. Each is [file, caption, label]; tap one to see it larger. */
const GUIDE_DIR = new URL('./guide/', import.meta.url).href;
function shots(list) {
  return `<div class="im-shots">${list.map(([file, caption, label]) => `<figure class="im-shot">
      <button type="button" data-action="zoom-shot" aria-label="Show larger: ${caption}"><img src="${GUIDE_DIR}${file}.webp" alt="${caption}" loading="lazy"></button>
      <figcaption>${label ? `<strong>${label}.</strong> ` : ''}${caption}</figcaption></figure>`).join('')}</div>`;
}

/** A section that opens on tap; stays open across redraws. */
function collapsible(key, title, hint, body, { defaultOpen = false, extraClass = '' } = {}) {
  const open = state.open?.[key] ?? defaultOpen;
  return `<div class="im-card im-collapsible ${extraClass}">
      <button class="im-collapse-head" data-action="toggle-open" data-id="${key}" aria-expanded="${open}">
        <span><strong>${title}</strong>${hint ? `<small>${hint}</small>` : ''}</span><span class="im-chevron" aria-hidden="true">${open ? '▾' : '▸'}</span>
      </button>
      ${open ? `<div class="im-collapse-body">${body}</div>` : ''}
    </div>`;
}

function commandsSection() {
  const commands = state.config.commands ?? {};
  const list = commands.list ?? [];
  const rows = list.map((c) => {
    const result = state.commandTests?.[c.id];
    return `<div class="im-command">
      <div class="row g-2">
        <div class="col-sm-4"><input class="form-control form-control-sm" placeholder="Projector Control" data-command-name="${escape(c.id)}" value="${escape(c.name ?? '')}" maxlength="40"></div>
        <div class="col-sm-8"><input class="form-control form-control-sm im-mono" placeholder="curl -s http://projector.local/lens?memory=2" data-command-line="${escape(c.id)}" value="${escape(c.command ?? '')}"></div>
      </div>
      <div class="d-flex gap-2 mt-1 align-items-center">
        <button class="btn btn-sm btn-outline-secondary" data-action="test-command" data-id="${escape(c.id)}" ${c.command ? '' : 'disabled'}>Test</button>
        <button class="btn btn-sm ${state.confirming === `command:${c.id}` ? 'btn-danger' : 'btn-outline-danger'}" data-action="remove-command" data-id="${escape(c.id)}">${state.confirming === `command:${c.id}` ? 'Tap again to remove' : 'Remove'}</button>
        ${result ? `<span class="im-hint m-0">${result.running ? 'Running…' : result.timedOut ? 'Stopped after 15 s' : result.code === 0 ? '✓ Worked' : `Failed (exit ${escape(result.code)})`}</span>` : ''}
      </div>
      ${result?.output ? `<pre class="im-output">${escape(result.output)}</pre>` : ''}
    </div>`;
  }).join('');
  return `<div class="im-field">
      <label for="im-commands"><strong>Commands</strong><small>Run your own commands when a sensor turns on or off or a button is pressed, for example to switch a projector's lens memory. Each sensor then has a "Run commands" choice.</small></label>
      <div class="form-check form-switch"><input id="im-commands" class="form-check-input" type="checkbox" data-commands-enabled ${commands.enabled ? 'checked' : ''}></div>
    </div>
    ${commands.enabled ? `<div class="im-field d-block">
      <div class="im-alert im-alert-warn small mb-2">Commands run on your Homebridge machine with the same access as Homebridge. Only add commands you trust.</div>
      ${rows || '<p class="im-hint mt-0">No commands yet.</p>'}
      <button class="btn btn-sm btn-outline-secondary mt-2" data-action="add-command">Add command</button>
      <p class="im-hint">Commands run on the Homebridge machine (inside the container when Homebridge runs in Docker), with a 30-second limit. You can use {title}, {type}, {library}, {player}, {user}, {sensor}, {state} and {event}; their values are quoted for you.</p>
    </div>` : ''}`;
}

function advancedTab() {
  const timing = state.config.timing ?? {};
  const fields = TIMING_FIELDS.map((f) => `<div class="im-field">
      <label for="im-${f.key}"><strong>${f.label}</strong><small>${f.help} ${f.min} to ${f.max} ${f.unit}.</small></label>
      <div class="input-group input-group-sm"><input id="im-${f.key}" type="number" class="form-control" data-timing="${f.key}"
        min="${f.min}" max="${f.max}" step="${f.step ?? 1}" value="${timingValue(timing, f)}"><span class="input-group-text">${f.unit}</span></div>
    </div>`).join('');
  const fallbackOff = timing.fallbackPercent === null;
  const percent = typeof timing.fallbackPercent === 'number' ? timing.fallbackPercent : 95;
  const webhook = state.config.webhook ?? {};
  const mode = creditsMode(timing);
  const sel = selection();
  const libraryNames = sel.allLibraries ? 'All libraries' : sel.libraries.map((l) => l.title).join(', ') || 'None';
  return `<div class="im-card">
      <strong>Your setup</strong>
      <dl class="im-facts">
        <dt>Plex servers</dt><dd>${escape(servers().map((s) => s.name).join(', ') || 'None')}</dd>
        <dt>Players</dt><dd>${escape(sel.allPlayers ? 'All players' : sel.players.map((p) => p.name).join(', ') || 'None')}</dd>
        <dt>People</dt><dd>${escape(sel.allUsers === false ? sel.users.join(', ') : 'All Plex Home users')}</dd>
        <dt>Libraries</dt><dd>${escape(libraryNames)}</dd>
        <dt>Bridge</dt><dd>${state.config._bridge ? `Intermission's own bridge${state.pairing?.paired ? ', in the Home app' : ''}` : 'Main Homebridge bridge'}</dd>
      </dl>
      <p class="im-hint">These are the starting choices for new sensors. Each sensor can still be changed on its own.</p>
      <div class="d-flex flex-wrap gap-2 mt-2">
        <button class="btn btn-sm btn-outline-secondary" data-action="redo-setup">Change servers, players and libraries</button>
        <button class="btn btn-sm ${state.confirming === 'signout' ? 'btn-danger' : 'btn-outline-danger'} ms-auto" data-action="signout">${state.confirming === 'signout' ? 'Tap again to sign out' : 'Sign out of Plex'}</button>
      </div>
    </div>

    <div class="im-card">
      <strong>Credits</strong>
      <div class="im-field">
        <label for="im-first"><strong>What counts as the credits</strong><small>${escape(CREDITS_MODES[mode].help)} Shared by every sensor that follows the credits ("except during the credits" or "In the credits"); also shown in their editors.</small></label>
        <select id="im-first" class="form-select form-select-sm" data-credits-mode>
          ${Object.entries(CREDITS_MODES).map(([id, m]) => `<option value="${id}" ${mode === id ? 'selected' : ''}>${escape(m.label)}${m.default ? ' (default)' : ''}</option>`).join('')}</select>
      </div>
      <div class="im-field">
        <label for="im-fallback"><strong>When a movie or episode has no credits marker</strong><small>With Plex Pass, Plex adds markers when it analyzes new media; without it, only items that already have markers have them. Otherwise use a share of the runtime. Movies and TV only.</small></label>
        <div><select id="im-fallback" class="form-select form-select-sm" data-fallback>
          <option value="percent" ${fallbackOff ? '' : 'selected'}>Use a percentage</option>
          <option value="off" ${fallbackOff ? 'selected' : ''}>No credits</option></select>
          ${fallbackOff ? '' : `<div class="input-group input-group-sm mt-1"><input type="number" class="form-control" min="50" max="99" data-fallback-percent value="${percent}"><span class="input-group-text">%</span></div>`}
        </div>
      </div>
    </div>

    <div class="im-card" id="im-webhooks">
      <strong>Plex Pass and webhooks</strong>
      <div class="mt-2">${webhookPanel()}</div>
      ${state.webhook?.plexPass && !state.webhook.error ? `<div class="d-flex flex-wrap gap-2 mt-2">
        <button class="btn btn-sm btn-im" data-action="apply-webhooks">Apply changes</button>
        <button class="btn btn-sm btn-outline-secondary" data-action="recheck-webhooks">Check again</button>
        ${state.webhook.registered ? `<button class="btn btn-sm ${state.confirming === 'remove-webhook' ? 'btn-danger' : 'btn-outline-danger'} ms-auto" data-action="remove-webhook">${state.confirming === 'remove-webhook' ? 'Tap again to remove' : 'Remove Intermission webhook'}</button>` : ''}
      </div>` : ''}
    </div>
    ${state.status.plexPass === false ? '' : collapsible('webhook-options', 'Webhook options', 'Port, address, and turning webhooks off.', `
      <div class="im-field">
        <label for="im-webhook"><strong>Receive Plex webhooks</strong><small>Makes play detection instant and adds the Plex Pass events.</small></label>
        <div class="form-check form-switch"><input id="im-webhook" class="form-check-input" type="checkbox" data-webhook-enabled ${webhook.enabled === false ? '' : 'checked'}></div>
      </div>
      <div class="im-field">
        <label for="im-port"><strong>Webhook port</strong><small>Change it only if another app uses ${DEFAULT_WEBHOOK_PORT}. 1024 to 65535.</small></label>
        <input id="im-port" type="number" class="form-control form-control-sm" min="1024" max="65535" data-webhook-port value="${webhook.port ?? DEFAULT_WEBHOOK_PORT}">
      </div>
      <div class="im-field">
        <label for="im-address"><strong>Homebridge address for Plex</strong><small>Leave empty to detect it. Set it if Plex is on another network. Example: http://10.0.0.5:32550</small></label>
        <input id="im-address" type="url" class="form-control form-control-sm" data-webhook-address placeholder="Automatic" value="${escape(webhook.advertisedUrl ?? '')}">
      </div>`)}

    ${collapsible('advanced', 'Advanced', 'Timing, logging and commands. These rarely need changing.', `
      ${fields}
      <div class="im-field">
        <label for="im-detailed"><strong>Detailed logging</strong><small>Shows every Plex report, event and decision in the Homebridge log, including why each sensor follows or ignores a playback. Diagnostics includes this detail either way, so you only need it to watch along live.</small></label>
        <div class="form-check form-switch"><input id="im-detailed" class="form-check-input" type="checkbox" data-detailed ${state.config.detailedLogging ? 'checked' : ''}></div>
      </div>
      ${commandsSection()}`)}

    ${diagnosticsCard()}

    ${collapsible('reset', 'Reset', '', `
      <div class="im-field d-block">
        <strong>Reset all settings</strong>
        <p class="small mb-2 mt-1">Puts every setting on this page back to its default: credits, webhook options, timing and logging. Your sensors, commands, sign-in and webhooks stay.</p>
        <button class="btn btn-sm ${state.confirming === 'reset-advanced' ? 'btn-danger' : 'btn-outline-secondary'}" data-action="reset-advanced">${state.confirming === 'reset-advanced' ? 'Tap again to reset all settings' : 'Reset all settings'}</button>
      </div>
      <div class="im-field d-block">
        <strong>Reset Intermission</strong>
        <p class="small mb-2 mt-1">Starts over as if freshly installed: signs out of Plex, removes the Intermission webhook from your Plex account, and deletes all sensors, commands and settings. Removed sensors disappear from Apple Home, and automations that use them stop working. Homebridge then asks to restart, and setup starts again here.</p>
        <button class="btn btn-sm ${state.confirming === 'reset-plugin' ? 'btn-danger' : 'btn-outline-danger'}" data-action="reset-plugin">${state.confirming === 'reset-plugin' ? 'Tap again to reset everything' : 'Reset Intermission…'}</button>
        ${state.confirming === 'reset-plugin' ? '<button class="btn btn-sm btn-outline-secondary ms-2" data-action="cancel-confirm">Cancel</button>' : ''}
      </div>`)}`;
}

/** Diagnostics for a bug report: setup, sensors and the recent log, with private details replaced. */
function diagnosticsCard() {
  return `<div class="im-card" id="im-diagnostics">
      <strong>Diagnostics</strong>
      <p class="small mt-1 mb-2">For reporting a problem: one text file with your setup, your sensors and Intermission's recent log. Intermission keeps that log on its own, so you don't need to turn on Detailed logging or make the problem happen again first.</p>
      <p class="im-hint mt-0 mb-2">It never includes your Plex sign-in or webhook key, and public addresses are hidden. Titles, people, players and command lines are replaced with placeholders such as "Title 1" unless you include them below. It's plain text, so you can read it before you share it.</p>
      <label class="im-row mb-2"><input type="checkbox" class="form-check-input" data-include-names ${state.includeNames ? 'checked' : ''}>
        <span>Include titles and names <small class="d-block im-muted">Only if the problem is about a specific title, person or player.</small></span></label>
      <div class="d-flex flex-wrap gap-2">
        <button class="btn btn-sm btn-im" data-action="download-diagnostics">Download diagnostics</button>
        <button class="btn btn-sm btn-outline-secondary" data-action="copy-diagnostics">Copy</button>
        <button class="btn btn-sm btn-outline-secondary" data-action="show-diagnostics">${state.report ? 'Refresh' : 'Show'}</button>
      </div>
      ${state.report ? `<textarea class="form-control im-report mt-2" readonly rows="16">${escape(state.report)}</textarea>` : ''}
    </div>`;
}

async function loadDiagnostics() {
  state.report = await request('/diagnostics', { ...reportBody(), includeNames: state.includeNames === true });
  return state.report;
}

// Footer icons, the same ones as the Gouly plugin.
const FOOTER_ICONS = {
  coffee: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9z"/><path d="M17 11h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M8 3.5c-.6.8.6 1.7 0 2.5M11.5 3.5c-.6.8.6 1.7 0 2.5M15 3.5c-.6.8.6 1.7 0 2.5"/></svg>',
  bug: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="7" width="10" height="13" rx="5"/><path d="M9 7a3 3 0 0 1 6 0M12 11v9M3 13h4M17 13h4M4 7l3 2M20 7l-3 2M4 19l3-2M20 19l-3-2"/></svg>',
  idea: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.3 1 2.1h5c0-.8.4-1.6 1-2.1A6 6 0 0 0 12 3z"/></svg>',
  github: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5z"/></svg>',
};

function footer() {
  const a = state.about;
  if (!a?.version) {
    return '';
  }
  const link = (href, icon, text) => (href ? `<a href="${escape(href)}" target="_blank" rel="noopener">${FOOTER_ICONS[icon]}<span>${text}</span></a>` : '');
  const env = homebridge.serverEnv?.env ?? {};
  const bugUrl = a.issues ? `${a.issues}/new?${new URLSearchParams({
    template: 'bug_report.yml',
    version: a.version,
    environment: `Homebridge UI ${env.packageVersion ?? '?'}, Node.js ${a.node}${env.runningInDocker ? ', Docker' : ''}`,
  })}` : '';
  const help = state.bugHelp && bugUrl ? `<div class="im-card im-banner mt-3 small">
      <strong>To get the quickest fix</strong>
      <ol class="mb-2 mt-1">
        <li>In Settings, Diagnostics, press <strong>Download diagnostics</strong> (or Copy). Do it soon after the problem: the log covers roughly the last day.</li>
        <li>Open the bug report, say what happened and when, and attach the file (or paste the text).</li>
        <li>The file never includes your Plex sign-in, and titles and names are replaced unless you choose to include them.</li>
      </ol>
      <div class="d-flex gap-2"><button class="btn btn-sm btn-outline-secondary" data-action="goto-diagnostics">Go to Diagnostics</button>
      <a class="btn btn-sm btn-im" href="${escape(bugUrl)}" target="_blank" rel="noopener">Open bug report</a>
      <button class="btn btn-sm btn-outline-secondary" data-action="bug-help">Close</button></div>
    </div>` : '';
  return `${help}<footer class="im-footer">${[
    link(a.funding, 'coffee', 'Buy me a coffee'),
    bugUrl ? `<a href="#" data-action="bug-help">${FOOTER_ICONS.bug}<span>Report a bug</span></a>` : '',
    link(a.issues && `${a.issues}/new?template=feature_request.yml`, 'idea', 'Suggest an idea'),
    link(a.repo, 'github', `v${escape(a.version)}`),
  ].filter(Boolean).join('')}</footer>`;
}

/* ---------- interaction ---------- */

function toggle(list, value) {
  const index = list.indexOf(value);
  if (index === -1) {
    list.push(value);
  } else {
    list.splice(index, 1);
  }
}

function toggleBy(list, item, key) {
  const index = list.findIndex((existing) => existing[key] === item[key]);
  if (index === -1) {
    list.push(item);
  } else {
    list.splice(index, 1);
  }
}

function setType(sensor, type) {
  const wasState = SENSOR_TYPES[sensor.type].state;
  sensor.type = type;
  if (SENSOR_TYPES[type].state && !wasState) {
    sensor.state = 'playing';
    sensor.except = ['credits'];
    delete sensor.events;
  } else if (!SENSOR_TYPES[type].state && wasState) {
    sensor.events = ['play'];
    delete sensor.state;
  }
}

/** Adds a preset's sensors; see applyPreset in model.js. */
function addPreset(id, mode) {
  const first = state.config.sensors.length === 0;
  state.config.sensors = applyPreset(state.config.sensors, id, selection(), mode);
  if (first || mode === 'replace') {
    state.config.preset = id;
  }
  state.presetChoice = undefined;
  state.presetPicker = false;
  homebridge.toast.success(`${PRESETS.find((p) => p.id === id)?.name ?? 'Preset'} added. Press Save, then restart Homebridge.`);
  return changed();
}

/** Stores a credits mode in config `timing`, leaving out the default. */
function setCreditsMode(mode) {
  const timing = { ...state.config.timing, midCredits: mode };
  delete timing.firstCreditsMarker;
  if (mode === 'scenes') {
    delete timing.midCredits;
  }
  state.config.timing = timing;
}

const mediaOf = (sensor) => {
  sensor.media ??= {};
  return sensor.media;
};

/** Drops empty media conditions so the saved config stays tidy. */
function mediaChanged() {
  const sensor = editingSensor();
  for (const [key, value] of Object.entries(sensor.media ?? {})) {
    if (value === undefined || (Array.isArray(value) && value.length === 0)) {
      delete sensor.media[key];
    }
  }
  if (Object.keys(sensor.media ?? {}).length === 0) {
    delete sensor.media;
  }
  state.open = { ...state.open, [`media:${sensor.id}`]: true };
  return changed();
}

const editingSensor = () => state.config.sensors.find((s) => s.id === state.editing);

async function changed() {
  state.dirty = true;
  render();
  await saveConfig();
}

/** Runs `action` on the second tap of the same control; the first tap only asks. */
function confirmThen(key, action) {
  if (state.confirming === key) {
    state.confirming = undefined;
    return action();
  }
  state.confirming = key;
  render();
  return undefined;
}

async function copy(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    homebridge.toast.success(done);
  } catch {
    homebridge.toast.info('Select the text and copy it.', 'Copy');
  }
}

const actions = {
  'signin-browser': () => beginSignIn('browser'),
  'signin-code': () => beginSignIn('code'),
  'to-signin': () => go('signin'),
  'reload-servers': () => loadServers(),
  'toggle-server': (el) => { toggle(state.chosenServers, el.dataset.id); render(); },
  'use-servers': () => useServers(),
  'toggle-player': (el) => { state.selection.allPlayers = false; toggleBy(state.selection.players, playerRef(state.discovery.players.find((p) => p.id === el.dataset.id)), 'id'); render(); },
  'users-all': () => { state.selection.allUsers = true; render(); },
  'users-some': () => { state.selection.allUsers = false; render(); },
  'toggle-library': (el) => {
    state.selection.allLibraries = false;
    const srv = state.discovery.servers.find((s) => s.libraries.some((l) => l.key === el.dataset.id));
    toggleBy(state.selection.libraries, libraryRef(srv, srv.libraries.find((l) => l.key === el.dataset.id)), 'key');
    render();
  },
  'refresh-choose': () => loadDiscovery('choose', { keepSelection: true }),
  'to-template': () => (state.config.sensors.length > 0 ? finishSetup() : go('template')),
  'back-choose': () => go('choose'),
  'pick-template': (el) => { state.template = el.dataset.id; render(); },
  finish: () => finishSetup(),
  tab: (el) => {
    state.tab = el.dataset.id;
    state.confirming = undefined;
    render();
  },
  refresh: () => refreshFromPlex(),
  edit: (el) => {
    state.editing = state.editing === el.dataset.id ? undefined : el.dataset.id;
    state.confirming = undefined;
    render();
  },
  add: (el) => {
    const sensor = newSensor(el.dataset.type);
    sensor.filters.players = selection().players.map((p) => p.id);
    state.config.sensors.push(sensor);
    state.editing = sensor.id;
    return changed();
  },
  'toggle-presets': () => {
    state.presetPicker = !(state.presetPicker || state.presetChoice);
    state.presetChoice = undefined;
    state.confirming = undefined;
    render();
  },
  'pick-preset': (el) => {
    state.tab = 'sensors';
    state.presetPicker = false;
    if (state.config.sensors.length === 0) {
      return addPreset(el.dataset.id, 'alongside');
    }
    state.presetChoice = el.dataset.id;
    state.confirming = undefined;
    render();
    document.getElementById('im-preset-choice')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return undefined;
  },
  'preset-alongside': () => addPreset(state.presetChoice, 'alongside'),
  'preset-replace': () => confirmThen('preset-replace', () => addPreset(state.presetChoice, 'replace')),
  'cancel-preset': () => { state.presetChoice = undefined; state.confirming = undefined; render(); },
  'remove-group': (el) => confirmThen(`group:${el.dataset.id}`, () => {
    state.config.sensors = state.config.sensors.filter((s) => s.group !== el.dataset.id);
    state.editing = undefined;
    return changed();
  }),
  delete: (el) => confirmThen(`delete:${el.dataset.id}`, () => {
    state.config.sensors = state.config.sensors.filter((s) => s.id !== el.dataset.id);
    state.editing = undefined;
    return changed();
  }),
  'cancel-confirm': () => { state.confirming = undefined; render(); },
  'zoom-shot': (el) => {
    el.closest('.im-shot').classList.toggle('im-shot-zoom');
    homebridge.fixScrollHeight?.();
  },
  'toggle-open': (el) => {
    // From what is on screen, since some sections start open.
    state.open = { ...state.open, [el.dataset.id]: el.getAttribute('aria-expanded') !== 'true' };
    render();
  },
  'add-command': () => {
    const commands = state.config.commands ?? { enabled: true, list: [] };
    commands.list = [...(commands.list ?? []), { id: sensorId().replace('s-', 'c-'), name: '', command: '' }];
    state.config.commands = commands;
    return changed();
  },
  'remove-command': (el) => confirmThen(`command:${el.dataset.id}`, () => {
    const id = el.dataset.id;
    state.config.commands.list = state.config.commands.list.filter((c) => c.id !== id);
    for (const sensor of state.config.sensors) {
      for (const key of ['on', 'off', 'press']) {
        if (sensor.run?.[key]) {
          sensor.run[key] = sensor.run[key].filter((c) => c !== id);
        }
      }
    }
    return changed();
  }),
  'test-command': async (el) => {
    const command = state.config.commands.list.find((c) => c.id === el.dataset.id);
    state.commandTests = { ...state.commandTests, [command.id]: { running: true } };
    render();
    const result = await request('/commands/test', { name: command.name, command: command.command });
    state.commandTests = { ...state.commandTests, [command.id]: result };
    render();
  },
  'toggle-run': (el) => {
    const sensor = editingSensor();
    sensor.run ??= { on: [], off: [], press: [] };
    sensor.run[el.dataset.when] ??= [];
    toggle(sensor.run[el.dataset.when], el.dataset.id);
    return changed();
  },
  'toggle-except': (el) => {
    const sensor = editingSensor();
    sensor.except ??= [];
    toggle(sensor.except, el.dataset.id);
    return changed();
  },
  'set-credits-mode': (el) => { setCreditsMode(el.dataset.id); return changed(); },
  'media-shape': (el) => {
    const media = mediaOf(editingSensor());
    media.shape = media.shape === el.dataset.id ? undefined : el.dataset.id;
    return mediaChanged();
  },
  'media-toggle': (el) => {
    const media = mediaOf(editingSensor());
    media[el.dataset.group] ??= [];
    toggle(media[el.dataset.group], el.dataset.id);
    return mediaChanged();
  },
  'media-any': (el) => {
    delete mediaOf(editingSensor())[el.dataset.group];
    return mediaChanged();
  },
  'media-add': (el) => {
    const media = mediaOf(editingSensor());
    const group = el.dataset.group;
    if (group === 'shape') {
      media.shape = el.dataset.id;
    } else {
      media[group] = [...new Set([...(media[group] ?? []), el.dataset.id])];
    }
    return mediaChanged();
  },
  'now-playing': async () => {
    state.nowPlaying = { loading: true };
    render();
    try {
      state.nowPlaying = { items: await request('/nowplaying', { servers: servers() }) };
    } catch (error) {
      state.nowPlaying = { error: error.message };
    }
    render();
  },
  'toggle-event': (el) => { toggle(editingSensor().events, el.dataset.id); return changed(); },
  'toggle-filter-players': (el) => { toggle(editingSensor().filters.players, el.dataset.id); return changed(); },
  'toggle-filter-users': (el) => { toggle(editingSensor().filters.users, el.dataset.id); return changed(); },
  'toggle-filter-libraries': (el) => { toggle(editingSensor().filters.libraries, el.dataset.id); return changed(); },
  'toggle-filter-mediaTypes': (el) => { toggle(editingSensor().filters.mediaTypes, el.dataset.id); return changed(); },
  reload: () => { location.reload(); },
  'bug-help': () => { state.bugHelp = !state.bugHelp; render(); },
  'open-webhooks': () => {
    state.tab = 'advanced';
    render();
    document.getElementById('im-webhooks')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },
  'toggle-remove': (el) => { toggle(state.webhookPlan.remove, el.dataset.url); render(); },
  'recheck-webhooks': () => busy('Checking Plex…', () => refreshWebhook(true)),
  'apply-webhooks': () => applyWebhookPlan(),
  'webhooks-next': async () => {
    if (state.webhook?.plexPass && !state.webhook.error && !(await applyWebhookPlan())) {
      return;
    }
    await loadDiscovery('choose');
  },
  'webhooks-skip': () => loadDiscovery('choose'),
  'cancel-setup': () => {
    state.setupServers = undefined;
    state.selection = undefined;
    state.discovery = undefined;
    go('main');
    void loadMain();
  },
  'players-all': () => { state.selection.allPlayers = true; state.selection.players = []; render(); },
  'libraries-all': () => { state.selection.allLibraries = true; state.selection.libraries = []; render(); },
  'filter-all': (el) => { editingSensor().filters[el.dataset.id] = []; return changed(); },
  'set-type': (el) => { setType(editingSensor(), el.dataset.id); return changed(); },
  'remove-webhook': () => confirmThen('remove-webhook', () => busy('Removing the webhook…', async () => {
    state.webhook = await request('/webhook/remove', webhookBody());
    state.webhookPlan = { add: false, remove: [] };
    homebridge.toast.success('The Intermission webhook was removed from your Plex account.', 'Plex webhooks');
  })),
  'show-diagnostics': () => busy('Collecting diagnostics…', loadDiagnostics),
  'copy-diagnostics': async () => {
    await busy('Collecting diagnostics…', loadDiagnostics);
    if (state.report) {
      await copy(state.report, 'Diagnostics copied.');
    }
  },
  'download-diagnostics': async () => {
    await busy('Collecting diagnostics…', loadDiagnostics);
    if (!state.report) {
      return;
    }
    try {
      const url = URL.createObjectURL(new Blob([state.report], { type: 'text/plain' }));
      const link = Object.assign(document.createElement('a'), { href: url, download: `intermission-diagnostics-${new Date().toISOString().slice(0, 10)}.txt` });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      homebridge.toast.success('If no file appeared, use Copy and paste the text into the bug report instead.', 'Diagnostics');
    } catch {
      homebridge.toast.info('This browser blocked the download. Use Copy instead.', 'Diagnostics');
    }
  },
  'recheck-pairing': async () => {
    await refreshPairing();
    if (state.pairing?.paired) {
      homebridge.toast.success('Intermission is in the Home app.', 'Apple Home');
    } else if (state.pairing?.published) {
      homebridge.toast.info('Not added yet. Finish adding it in the Home app, then check again.', 'Apple Home');
    }
    render();
  },
  'goto-diagnostics': () => {
    state.tab = 'advanced';
    state.bugHelp = false;
    render();
    document.getElementById('im-diagnostics')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },
  'reset-advanced': () => confirmThen('reset-advanced', () => {
    delete state.config.timing;
    delete state.config.webhook;
    delete state.config.detailedLogging;
    homebridge.toast.success('All settings are back to their defaults. Press Save to keep them.');
    return changed();
  }),
  'reset-plugin': () => confirmThen('reset-plugin', () => busy('Resetting Intermission…', async () => {
    const result = await request('/reset', webhookBody());
    // The child bridge stays: it is already in the Home app, and setup adds the new sensors to it.
    state.config = { platform: PLATFORM, name: state.config.name ?? 'Intermission', sensors: [], ...(state.config._bridge ? { _bridge: state.config._bridge } : {}) };
    await saveConfig({ persist: true });
    state.status = { signedIn: false };
    state.discovery = undefined;
    state.webhook = undefined;
    homebridge.toast.success(`Intermission was reset${result.webhookRemoved ? ' and its webhook removed from Plex' : ''}. Restart Homebridge when asked, then set it up again.`, 'Reset');
    // Closing the settings lets Homebridge offer the restart for the changed config.
    homebridge.closeSettings();
  })),
  'ack-plexpass': async () => {
    await request('/plexpass/ack');
    state.status.plexPassChange = undefined;
    render();
  },
  'recheck-plexpass': () => busy('Checking Plex Pass…', async () => {
    state.status = await request('/status', { setupId: state.config.setupId });
    await refreshWebhook();
  }),
  'redo-setup': () => loadServers(),
  signout: () => confirmThen('signout', () => busy('Signing out…', async () => {
    state.status = await request('/signout');
    go('signin');
  })),
};

root.addEventListener('click', (event) => {
  const el = event.target.closest('[data-action]');
  if (!el || !root.contains(el) || el.disabled) {
    return;
  }
  event.preventDefault();
  Promise.resolve(actions[el.dataset.action]?.(el)).catch((error) => {
    state.error = error.message;
    render();
  });
});

root.addEventListener('change', (event) => {
  const el = event.target;
  if (el.dataset.user !== undefined) {
    toggle(state.selection.users, el.dataset.user);
    render();
    return;
  }
  const sensor = editingSensor();
  const field = el.dataset.field;
  if (sensor && field) {
    if (field === 'name') {
      sensor.name = el.value.trim() || sensor.name;
    } else if (field === 'state') {
      sensor.state = el.value;
      if (!CAN_EXCEPT.includes(sensor.state)) {
        sensor.except = [];
      }
    }
    void changed();
    return;
  }
  const config = state.config;
  if (el.dataset.timing) {
    config.timing = setTiming(config.timing ?? {}, TIMING_FIELDS.find((f) => f.key === el.dataset.timing), el.value);
  } else if (el.hasAttribute('data-credits-mode')) {
    setCreditsMode(el.value);
  } else if (el.hasAttribute('data-media-labels')) {
    const sensor = editingSensor();
    mediaOf(sensor).labels = [...new Set(el.value.split(',').map((l) => l.trim()).filter(Boolean))];
    void mediaChanged();
    return;
  } else if (el.hasAttribute('data-child-bridge')) {
    state.useChildBridge = el.checked;
    render();
    return;
  } else if (el.hasAttribute('data-include-names')) {
    state.includeNames = el.checked;
    state.report = '';
    render();
    return;
  } else if (el.hasAttribute('data-webhook-add')) {
    state.webhookPlan.add = el.checked;
    render();
    return;
  } else if (el.hasAttribute('data-fallback')) {
    config.timing = { ...config.timing };
    if (el.value === 'off') {
      config.timing.fallbackPercent = null;
    } else {
      delete config.timing.fallbackPercent;
    }
  } else if (el.hasAttribute('data-fallback-percent')) {
    const value = Math.min(99, Math.max(50, Math.round(Number(el.value) || 95)));
    config.timing = { ...config.timing, fallbackPercent: value };
    if (value === 95) {
      delete config.timing.fallbackPercent;
    }
  } else if (el.hasAttribute('data-webhook-enabled')) {
    config.webhook = { ...config.webhook, enabled: el.checked };
  } else if (el.hasAttribute('data-webhook-port')) {
    const port = Math.round(Number(el.value));
    config.webhook = { ...config.webhook, port: port >= 1024 && port <= 65535 ? port : DEFAULT_WEBHOOK_PORT };
  } else if (el.hasAttribute('data-webhook-address')) {
    config.webhook = { ...config.webhook, advertisedUrl: el.value.trim() || undefined };
  } else if (el.hasAttribute('data-commands-enabled')) {
    config.commands = { list: [], ...config.commands, enabled: el.checked };
  } else if (el.dataset.commandName !== undefined || el.dataset.commandLine !== undefined) {
    const command = config.commands.list.find((c) => c.id === (el.dataset.commandName ?? el.dataset.commandLine));
    if (el.dataset.commandName !== undefined) {
      command.name = el.value.trim();
    } else {
      command.command = el.value.trim();
    }
  } else if (el.hasAttribute('data-detailed')) {
    config.detailedLogging = el.checked;
  } else {
    return;
  }
  void changed();
});

/* Drag to reorder sensor cards. */
let dragFrom;
root.addEventListener('dragstart', (event) => {
  const card = event.target.closest?.('.im-sensor[draggable="true"]');
  if (card) {
    dragFrom = Number(card.dataset.index);
    card.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
  }
});
root.addEventListener('dragover', (event) => {
  const card = event.target.closest?.('.im-sensor');
  if (card && dragFrom !== undefined) {
    event.preventDefault();
    root.querySelectorAll('.drop-target').forEach((c) => c.classList.remove('drop-target'));
    card.classList.add('drop-target');
  }
});
root.addEventListener('drop', (event) => {
  const card = event.target.closest?.('.im-sensor');
  if (card && dragFrom !== undefined) {
    event.preventDefault();
    const to = Number(card.dataset.index);
    const [moved] = state.config.sensors.splice(dragFrom, 1);
    state.config.sensors.splice(to, 0, moved);
    dragFrom = undefined;
    void changed();
  }
});
root.addEventListener('dragend', () => {
  dragFrom = undefined;
  root.querySelectorAll('.dragging, .drop-target').forEach((c) => c.classList.remove('dragging', 'drop-target'));
});

homebridge.addEventListener('ready', () => {
  start().catch((error) => {
    state.error = error.message;
    go('signin');
  });
});
