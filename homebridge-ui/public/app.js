import { DEVICE_ICONS, deviceIcon, LIBRARY_ICONS, PEOPLE_ICONS, SENSOR_ICONS } from './device-icons.js';
import {
  CONDITIONS, DEFAULT_WEBHOOK_PORT, EVENTS, LIBRARY_KINDS, MEDIA_TYPES, PLATFORM, PRESETS, DEFAULT_PRESET, SENSOR_TYPES, TIMING_FIELDS,
  availableMediaTypes, defaultSelection, libraryRef, needsPlexPass, presetSensors, newSensor, playerRef, setTiming, summarize, timingValue,
} from './model.js';

const root = document.getElementById('intermission');
const POLL_MS = 2000;
const CREDIT_KINDS = new Set(['movie', 'show']);

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
};

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
  }
}

const servers = () => state.config.servers ?? [];
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
  await refreshWebhook();
  render();
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
    const owned = state.servers.filter((s) => s.owned);
    state.chosenServers = (owned.length > 0 ? owned : state.servers).map((s) => s.id);
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
    state.config.servers = result.servers;
    await saveConfig();
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

async function loadDiscovery(next) {
  go(next);
  await busy('Looking for your players, people and libraries…', async () => {
    state.discovery = await request('/discover', { servers: servers() });
    state.selection = state.config.selection ? structuredClone(state.config.selection) : defaultSelection(state.discovery);
    state.selection.allUsers ??= state.selection.users.length === 0;
  });
}

async function finishSetup() {
  state.config.selection = state.selection;
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
    if (state.tab === 'advanced') {
      state.report = await request('/report', reportBody());
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
  root.innerHTML = `${(views[state.view] ?? loading)()}${footer()}`;
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
    <p class="text-center im-muted small">Your Plex sign-in is stored only on this Homebridge, readable by Homebridge alone.</p>`;
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
    </div>`;
}

function section(title, help, body) {
  return `<section class="im-section"><header><h6>${title}</h6><p>${help}</p></header>${body}</section>`;
}

function choose() {
  if (state.busy || !state.discovery) {
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
    ${section('Libraries', 'Movies and TV Shows are chosen for you. Credits only apply to movies and TV episodes; other libraries still dim and restore the lights.', libraryPicker(sel))}
    <div class="d-flex gap-2">
      <button class="btn btn-im" data-action="to-template" ${(sel.allUsers === false && sel.users.length === 0) || (!sel.allPlayers && sel.players.length === 0) || (!sel.allLibraries && sel.libraries.length === 0) ? 'disabled' : ''}>Next</button>
      <button class="btn btn-outline-secondary" data-action="refresh-choose">Refresh</button>
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
      <span class="im-step">Option ${index + 1}</span>
      <div><strong>${escape(preset.name)}</strong>${preset.recommended ? ' <span class="im-badge on ms-1">Recommended</span>' : ''}
        <span class="im-muted"> · ${escape(preset.tagline)}</span></div>
      <p class="im-muted mb-2 mt-1">${escape(preset.about)}</p>
      <ul class="im-preset">${items}</ul>
    </button>`;
  }).join('');
  return `${stepHeader(4, 'Choose a starting setup')}${notices()}
    <p class="im-muted small">Every option uses sensors, which Apple Home can always read, so a missed update corrects itself. You can change anything later.</p>
    ${cards}
    <p class="small mt-1"><button class="im-link" data-action="pick-template" data-id="scratch">${state.template === 'scratch' ? '✓ ' : ''}Start from scratch instead</button></p>
    <div class="d-flex gap-2 mt-2">
      <button class="btn btn-im" data-action="finish" ${state.busy ? 'disabled' : ''}>${state.template === 'scratch' ? 'Finish' : 'Create sensors'}</button>
      <button class="btn btn-outline-secondary" data-action="back-choose">Back</button>
    </div>`;
}

function main() {
  const tabs = { sensors: 'Sensors', recipes: 'Recipes & Notes', advanced: 'Advanced' };
  const nav = Object.entries(tabs).map(([id, label]) => `<button class="im-tab" role="tab" aria-selected="${state.tab === id}" data-action="tab" data-id="${id}">${label}</button>`).join('');
  const content = { sensors: sensorsTab, recipes: recipesTab, advanced: advancedTab }[state.tab]();
  const pass = state.status.plexPass === undefined ? '' : `<span class="im-badge ${state.status.plexPass ? 'on' : ''}">${state.status.plexPass ? 'Plex Pass' : 'No Plex Pass'}</span>`;
  return `<div class="im-header">
      <img src="icon.svg" alt="">
      <div class="im-who"><strong>${escape(servers().map((s) => s.name).join(', ') || 'Plex')}</strong><br>
        <small>Signed in as ${escape(state.status.username ?? 'Plex user')}</small></div>
      ${pass}
      <button class="btn btn-sm btn-outline-secondary" data-action="refresh" ${state.busy ? 'disabled' : ''}>Refresh from Plex</button>
    </div>
    ${state.status.signedIn ? '' : '<div class="im-alert">Signed out. <button class="im-link" data-action="to-signin">Sign in again</button></div>'}
    ${notices()}
    <div class="im-tabs" role="tablist">${nav}</div>${content}`;
}

function sensorsTab() {
  const sel = selection();
  const cards = state.config.sensors.map((sensor, index) => {
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
  }).join('');
  return `${webhookNotice()}
    ${cards || '<p class="im-muted">No sensors yet.</p>'}
    <div class="d-flex flex-wrap gap-2 mt-2">
      <button class="btn btn-im" data-action="add" data-type="occupancy">Add sensor</button>
      <button class="btn btn-outline-secondary" data-action="add" data-type="button">Add button</button>
      ${state.config.sensors.length === 0 ? PRESETS.map((p) => `<button class="btn btn-outline-secondary" data-action="add-template" data-id="${p.id}">Add ${escape(p.name)}</button>`).join('') : ''}
    </div>
    <p class="im-muted small mt-3">Drag cards to reorder. Changes apply after you press Save and restart Homebridge. Renaming keeps your Home automations.</p>`;
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
  const usesCredits = (sensor.events ?? []).some((e) => e.startsWith('credits')) || sensor.state === 'credits' || sensor.state === 'playing';
  const noCredits = usesCredits && chosenLibraries.some((l) => !CREDIT_KINDS.has(l.kind));
  const noPass = state.status.plexPass === false;
  const confirming = state.confirming === `delete:${sensor.id}`;
  return `<div class="im-editor" data-sensor="${escape(sensor.id)}">
    <label class="im-label" for="im-name">Name in Apple Home</label>
    <input id="im-name" class="form-control" data-field="name" value="${escape(sensor.name)}" maxlength="64">
    <label class="im-label">Type <span>(not sure? keep Occupancy for states, Button for moments)</span></label>
    <div class="im-options im-types">${types}</div>
    ${isState
      ? `<label class="im-label" for="im-state">On while</label><select id="im-state" class="form-select" data-field="state">${conditions}</select>`
      : `<label class="im-label">Pressed when</label><div class="im-chips">${chips('toggle-event', Object.keys(EVENTS), sensor.events ?? [],
        (e) => `${EVENTS[e].label}${EVENTS[e].plexPass ? ' ★' : ''}`, (e) => noPass && EVENTS[e].plexPass)}</div>
        <div class="im-hint">★ needs Plex Pass</div>`}
    <label class="im-label">Players</label>
    ${filter('players', players, (p) => p.name, 'All players')}
    <label class="im-label">People</label>
    ${filter('users', users, (u) => u, 'All Plex Home users')}
    <label class="im-label">Libraries</label>
    ${filter('libraries', libraries, (l) => (many ? `${l.title} · ${l.serverName}` : l.title), 'All libraries')}
    ${mediaTypes.length > 1 ? `<label class="im-label">Media types</label>
      ${filter('mediaTypes', mediaTypes, (t) => MEDIA_TYPES[t], 'All media types')}` : ''}
    ${noCredits ? '<p class="im-hint mt-2">Music, photos and other videos have no credits, so this sensor treats them as playing until they pause or stop.</p>' : ''}
    <div class="d-flex gap-2 mt-3">
      <button class="btn btn-sm ${confirming ? 'btn-danger' : 'btn-outline-danger'}" data-action="delete" data-id="${escape(sensor.id)}">${confirming ? 'Tap again to remove' : `Remove ${sensor.type === 'button' ? 'button' : 'sensor'}`}</button>
      ${confirming ? '<button class="btn btn-sm btn-outline-secondary" data-action="cancel-confirm">Keep it</button>' : ''}
    </div>
  </div>`;
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
  free: (port) => `Port ${port} is free. Intermission listens on it once Homebridge restarts.`,
  intermission: (port) => `Intermission is listening on port ${port}.`,
  other: (port) => `Another app is using port ${port}. Choose a different port below, or Plex's webhooks will reach that app instead.`,
  unknown: (port) => `Could not check port ${port}.`,
};

/** Plex Pass, server settings, the account's webhooks with remove buttons, and Intermission's. */
function webhookPanel() {
  const hook = state.webhook;
  if (!hook) {
    return '<p class="im-muted">Checking…</p>';
  }
  if (hook.error) {
    return `<div class="im-alert im-alert-danger">${escape(hook.error)}</div>`;
  }
  const plan = state.webhookPlan;
  const passRow = `<div class="im-status ${hook.plexPass ? 'ok' : 'warn'}"><span class="im-dot"></span><div>
      <strong>${hook.plexPass ? 'Plex Pass is active' : 'No Plex Pass on this account'}</strong>
      <small>${hook.plexPass
        ? 'Webhooks make play detection instant and add events such as "Marked as watched" and "Added to a library".'
        : 'Intermission still works without it: pause, resume and stop are instant, play is noticed within about 10 seconds, and credits use markers already on your server or 95% of the runtime. Webhooks and their events need Plex Pass.'}</small>
    </div></div>`;
  if (!hook.plexPass) {
    return passRow;
  }
  const settings = hook.serverSettings.map((srv) => `<div class="im-status ${srv.enabled === false ? 'warn' : srv.enabled ? 'ok' : ''}"><span class="im-dot"></span><div>
      <strong>${escape(srv.name)}: Webhooks setting ${srv.enabled === undefined ? 'unknown' : srv.enabled ? 'on' : 'off'}</strong>
      <small>${srv.enabled === false ? 'Plex sends no webhooks while this is off. It is turned on when you add the Intermission webhook.' : srv.enabled ? 'In Plex: Settings, Network, Webhooks.' : 'Only the server owner can read this setting.'}</small>
    </div></div>`).join('');
  const port = `<div class="im-status ${hook.portState === 'other' ? 'bad' : hook.portState === 'intermission' ? 'ok' : ''}"><span class="im-dot"></span><div>
      <strong>Webhook port ${hook.port}</strong><small>${PORT_TEXT[hook.portState]?.(hook.port) ?? ''}</small>
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
    </div>`;
}

function recipesTab() {
  const sensorRecipe = (title, sensor, body) => `<div class="im-card"><h6>${title}</h6><ol>
      <li>In the Home app, tap <strong>+</strong>, then <strong>Add Automation</strong>, then <strong>A Sensor Detects Something</strong>.</li>
      <li>Choose <strong>${sensor}</strong>, then <strong>Detects Occupancy</strong>.</li>${body}</ol></div>`;
  return `<div class="im-recipe">
    <p class="im-muted">Intermission makes the sensors; Apple Home turns them into light changes.</p>
    <h6 class="mt-3">Simple and Credits-Aware (one sensor)</h6>
    ${sensorRecipe('Lights down when something plays', 'Media Playing', '<li>Choose your lights and set them dim, or pick a scene.</li>')}
    <div class="im-card"><h6>Lights up when it stops playing</h6><ol>
      <li>Add an automation: <strong>A Sensor Detects Something</strong>, <strong>Media Playing</strong>, <strong>Stops Detecting</strong>.</li>
      <li>Set your normal lighting. With Credits-Aware this also runs at the credits, and the first automation dims again for a mid-credits scene.</li>
      <li>For a gentle fade instead, use the fade shortcut below with <strong>Media Playing</strong>: stop the shortcut if it is detected.</li></ol></div>
    <h6 class="mt-4">Every State (four sensors)</h6>
    <p class="im-muted small">Exactly one of the four is on at a time, so each gets one automation.</p>
    ${sensorRecipe('Lights down when something plays', 'Media Playing', '<li>Choose your lights and set them dim, or pick a scene.</li>')}
    ${sensorRecipe('Lights up a little on pause', 'Media Paused', '<li>Set the lights to a comfortable level.</li>')}
    <div class="im-card"><h6>Slow fade up at the credits</h6>
      <p class="small im-muted mb-2">Apple Home has no fade-time setting, so the fade is a short shortcut that steps the lights up.</p><ol>
      <li>Add an automation: <strong>A Sensor Detects Something</strong>, <strong>Credits Rolling</strong>, <strong>Detects Occupancy</strong>. Choose any light, then scroll down and tap <strong>Convert To Shortcut</strong>.</li>
      <li>Replace the steps with <strong>Repeat 10 times</strong>, containing: <strong>Get the state of Credits Rolling</strong>; <strong>If</strong> it is not detected, <strong>Stop This Shortcut</strong>; set the lights' brightness up by 10%; <strong>Wait 6 seconds</strong>.</li>
      <li>That brings the lights up over a minute, and stops the moment you rewind, pause or stop.</li></ol></div>
    ${sensorRecipe('Lights back to normal when it ends', 'Nothing Playing', '<li>Set your normal lighting.</li>')}
    <h6 class="mt-4">Notes</h6>
    <ul class="small">
      <li><strong>Why sensors, not buttons?</strong> A sensor is a state Home can read at any time. If Home misses a change (a hub restart, Wi-Fi drop or Homebridge restart), it sees the right state as soon as it reconnects, and a fade can check whether playback came back. A button press Home misses is simply gone. Buttons are still available for one-off actions.</li>
      <li>Short pauses (under 2 seconds), skips and quick pause-play-pause bursts don't change any sensor, so lights never stutter. Adjust this in Advanced.</li>
      <li>Mid-credits scenes count as playing by default: the lights dim again for the scene and come back up for the rest of the credits. Change it in Advanced.</li>
      <li>Music, photos and other videos have no credits. Their sensors go from Playing to Paused or Nothing Playing.</li>
      <li>Rewinding out of the credits turns Credits Rolling off and Media Playing back on.</li>
      <li>Autoplaying the next episode isn't a stop.</li>
      <li>After a Homebridge restart, sensors keep their last state until Plex has been read, so lights don't jump.</li>
      <li>Renaming a sensor here keeps the automations that use it. Removing it removes it from Apple Home.</li>
    </ul></div>`;
}

function advancedTab() {
  const timing = state.config.timing ?? {};
  const fields = TIMING_FIELDS.map((f) => `<div class="im-field">
      <label for="im-${f.key}"><strong>${f.label}</strong><small>${f.help} ${f.min} to ${f.max} ${f.unit}.</small></label>
      <div class="input-group input-group-sm"><input id="im-${f.key}" type="number" class="form-control" data-timing="${f.key}"
        min="${f.min}" max="${f.max}" value="${timingValue(timing, f)}"><span class="input-group-text">${f.unit}</span></div>
    </div>`).join('');
  const fallbackOff = timing.fallbackPercent === null;
  const percent = typeof timing.fallbackPercent === 'number' ? timing.fallbackPercent : 95;
  const webhook = state.config.webhook ?? {};
  return `<div class="im-card im-banner mb-3">These rarely need changing. The defaults suit most setups.</div>
    <div class="im-card">
      <div class="im-field">
        <label for="im-first"><strong>Mid-credits scenes</strong><small>Some movies have a scene between two parts of the credits. Intermission can treat it as playing (lights dim again), or ignore it.</small></label>
        <select id="im-first" class="form-select form-select-sm" data-credits-mode>
          <option value="scenes" ${(timing.midCredits ?? (timing.firstCreditsMarker === false ? 'final' : 'scenes')) === 'scenes' ? 'selected' : ''}>Dim for the scene (recommended)</option>
          <option value="first" ${(timing.midCredits ?? (timing.firstCreditsMarker === false ? 'final' : 'scenes')) === 'first' ? 'selected' : ''}>Lights up from the first credits</option>
          <option value="final" ${(timing.midCredits ?? (timing.firstCreditsMarker === false ? 'final' : 'scenes')) === 'final' ? 'selected' : ''}>Lights down until the final credits</option></select>
      </div>
      <div class="im-field">
        <label for="im-fallback"><strong>When a movie or episode has no credits marker</strong><small>Plex adds markers when it analyses new media. Until then, use a share of the runtime. With or without Plex Pass.</small></label>
        <div><select id="im-fallback" class="form-select form-select-sm" data-fallback>
          <option value="percent" ${fallbackOff ? '' : 'selected'}>Use a percentage</option>
          <option value="off" ${fallbackOff ? 'selected' : ''}>No credits event</option></select>
          ${fallbackOff ? '' : `<div class="input-group input-group-sm mt-1"><input type="number" class="form-control" min="50" max="99" data-fallback-percent value="${percent}"><span class="input-group-text">%</span></div>`}
        </div>
      </div>
      ${fields}
    </div>
    <div class="im-card">
      <div class="im-field d-block" id="im-webhooks">
        <strong>Plex Pass and webhooks</strong>
        <div class="mt-2">${webhookPanel()}</div>
        ${state.webhook?.plexPass && !state.webhook.error ? `<div class="d-flex gap-2 mt-2">
          <button class="btn btn-sm btn-im" data-action="apply-webhooks">Apply changes</button>
          <button class="btn btn-sm btn-outline-secondary" data-action="recheck-webhooks">Check again</button>
          ${state.webhook.registered ? `<button class="btn btn-sm ${state.confirming === 'remove-webhook' ? 'btn-danger' : 'btn-outline-danger'} ms-auto" data-action="remove-webhook">${state.confirming === 'remove-webhook' ? 'Tap again to remove' : 'Remove Intermission webhook'}</button>` : ''}
        </div>` : ''}
      </div>
      <div class="im-field">
        <label for="im-webhook"><strong>Receive Plex webhooks</strong><small>Needs Plex Pass. Makes play detection instant.</small></label>
        <div class="form-check form-switch"><input id="im-webhook" class="form-check-input" type="checkbox" data-webhook-enabled ${webhook.enabled === false ? '' : 'checked'}></div>
      </div>
      <div class="im-field">
        <label for="im-port"><strong>Webhook port</strong><small>Change it only if another app uses ${DEFAULT_WEBHOOK_PORT}. 1024 to 65535.</small></label>
        <input id="im-port" type="number" class="form-control form-control-sm" min="1024" max="65535" data-webhook-port value="${webhook.port ?? DEFAULT_WEBHOOK_PORT}">
      </div>
      <div class="im-field">
        <label for="im-address"><strong>Homebridge address for Plex</strong><small>Leave empty to detect it. Example: http://10.0.0.5:32550</small></label>
        <input id="im-address" type="url" class="form-control form-control-sm" data-webhook-address placeholder="Automatic" value="${escape(webhook.advertisedUrl ?? '')}">
      </div>
      <div class="im-field">
        <label for="im-detailed"><strong>Detailed logging</strong><small>Logs every event and timer decision. Turn on when reporting a problem.</small></label>
        <div class="form-check form-switch"><input id="im-detailed" class="form-check-input" type="checkbox" data-detailed ${state.config.detailedLogging ? 'checked' : ''}></div>
      </div>
    </div>
    <div class="d-flex flex-wrap gap-2">
      <button class="btn btn-outline-secondary" data-action="reset-advanced">Reset to defaults</button>
      <button class="btn btn-outline-secondary" data-action="redo-setup">Change servers, players and libraries</button>
      <button class="btn ${state.confirming === 'signout' ? 'btn-danger' : 'btn-outline-danger'} ms-auto" data-action="signout">${state.confirming === 'signout' ? 'Tap again to sign out' : 'Sign out of Plex'}</button>
    </div>
    <div class="im-card mt-3">
      <div class="d-flex align-items-center mb-2"><strong>About this setup</strong>
        <span class="ms-auto d-flex gap-1">
          <button class="btn btn-sm btn-outline-secondary" data-action="load-report">${state.report ? 'Refresh' : 'Show'}</button>
          ${state.report ? '<button class="btn btn-sm btn-outline-secondary" data-action="copy-report">Copy</button>' : ''}
        </span></div>
      <p class="im-hint mb-2">Server, Plex Pass, libraries and settings, for troubleshooting. Contains no sign-in token. Public addresses are hidden.</p>
      ${state.report ? `<textarea class="form-control im-report" readonly rows="14">${escape(state.report)}</textarea>` : ''}
    </div>`;
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
        <li>Advanced: turn on Detailed logging, press Save, restart Homebridge, then make the problem happen again.</li>
        <li>Advanced: About this setup, then Copy. It never contains your Plex sign-in.</li>
        <li>Open the bug report and paste it in, with the log lines.</li>
      </ol>
      <div class="d-flex gap-2"><a class="btn btn-sm btn-im" href="${escape(bugUrl)}" target="_blank" rel="noopener">Open bug report</a>
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
    delete sensor.events;
  } else if (!SENSOR_TYPES[type].state && wasState) {
    sensor.events = ['play'];
    delete sensor.state;
  }
}

const editingSensor = () => state.config.sensors.find((s) => s.id === state.editing);

async function changed() {
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
  'refresh-choose': () => loadDiscovery('choose'),
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
  'add-template': (el) => {
    state.config.sensors = presetSensors(el.dataset.id, selection());
    state.config.preset = el.dataset.id;
    return changed();
  },
  delete: (el) => confirmThen(`delete:${el.dataset.id}`, () => {
    state.config.sensors = state.config.sensors.filter((s) => s.id !== el.dataset.id);
    state.editing = undefined;
    return changed();
  }),
  'cancel-confirm': () => { state.confirming = undefined; render(); },
  'toggle-event': (el) => { toggle(editingSensor().events, el.dataset.id); return changed(); },
  'toggle-filter-players': (el) => { toggle(editingSensor().filters.players, el.dataset.id); return changed(); },
  'toggle-filter-users': (el) => { toggle(editingSensor().filters.users, el.dataset.id); return changed(); },
  'toggle-filter-libraries': (el) => { toggle(editingSensor().filters.libraries, el.dataset.id); return changed(); },
  'toggle-filter-mediaTypes': (el) => { toggle(editingSensor().filters.mediaTypes, el.dataset.id); return changed(); },
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
  'players-all': () => { state.selection.allPlayers = true; state.selection.players = []; render(); },
  'libraries-all': () => { state.selection.allLibraries = true; state.selection.libraries = []; render(); },
  'filter-all': (el) => { editingSensor().filters[el.dataset.id] = []; return changed(); },
  'set-type': (el) => { setType(editingSensor(), el.dataset.id); return changed(); },
  'remove-webhook': () => confirmThen('remove-webhook', () => busy('Removing the webhook…', async () => {
    state.webhook = await request('/webhook/remove', webhookBody());
  })),
  'load-report': () => busy('Collecting details…', async () => {
    state.report = await request('/report', reportBody());
  }),
  'copy-report': () => copy(state.report, 'Copied.'),
  'reset-advanced': () => {
    delete state.config.timing;
    delete state.config.webhook;
    delete state.config.detailedLogging;
    homebridge.toast.info('Advanced settings reset. Press Save to keep them.');
    return changed();
  },
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
    }
    void changed();
    return;
  }
  const config = state.config;
  if (el.dataset.timing) {
    config.timing = setTiming(config.timing ?? {}, TIMING_FIELDS.find((f) => f.key === el.dataset.timing), el.value);
  } else if (el.hasAttribute('data-credits-mode')) {
    config.timing = { ...config.timing, midCredits: el.value };
    delete config.timing.firstCreditsMarker;
    if (el.value === 'scenes') {
      delete config.timing.midCredits;
    }
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
