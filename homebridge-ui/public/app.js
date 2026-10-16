import { deviceIcon } from './device-icons.js';
import {
  CONDITIONS, DEFAULT_WEBHOOK_PORT, EVENTS, MEDIA_TYPES, MOVIE_NIGHT, PLATFORM, SENSOR_TYPES, TIMING_FIELDS,
  defaultSelection, movieNight, needsPlexPass, newSensor, playerRef, setTiming, summarize, timingValue,
} from './model.js';

const root = document.getElementById('intermission');
const POLL_MS = 2000;

const state = {
  config: undefined,
  status: { signedIn: false },
  view: 'loading',
  tab: 'sensors',
  servers: [],
  discovery: undefined,
  selection: undefined,
  template: 'movie-night',
  signIn: undefined,
  editing: undefined,
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

function selection() {
  return state.config.selection ?? { players: [], users: [], libraries: [] };
}

/* ---------- flow ---------- */

async function start() {
  homebridge.hideSchemaForm();
  const configs = await homebridge.getPluginConfig();
  state.config = configs[0] ?? { platform: PLATFORM, name: 'Intermission' };
  state.config.sensors ??= [];
  try {
    state.status = await request('/status');
  } catch (error) {
    state.error = error.message;
  }
  route();
}

function route() {
  if (!state.status.signedIn) {
    go('signin');
  } else if (!state.config.server) {
    void loadServers();
  } else if (state.config.sensors.length === 0 && !state.config.selection) {
    void loadDiscovery('choose');
  } else {
    go('main');
  }
}

function go(view) {
  state.view = view;
  state.busy = '';
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
  state.view = 'server';
  await busy('Finding your Plex servers…', async () => {
    state.servers = await request('/servers');
  });
  if (state.servers.length === 1 && !state.error) {
    await selectServer(state.servers[0].id);
  }
}

async function selectServer(id) {
  const name = state.servers.find((s) => s.id === id)?.name ?? 'the server';
  await busy(`Finding the best way to reach ${name}…`, async () => {
    state.config.server = await request('/server/select', { id });
    await saveConfig({ persist: true });
  });
  if (!state.error) {
    await loadDiscovery('choose');
  }
}

async function loadDiscovery(next) {
  state.view = next;
  await busy('Looking for your players and libraries…', async () => {
    state.discovery = await request('/discover', { url: state.config.server.url });
    state.selection = state.config.selection ? structuredClone(state.config.selection) : defaultSelection(state.discovery);
  });
}

async function finishSetup() {
  state.config.selection = state.selection;
  if (state.template === 'movie-night' && state.config.sensors.length === 0) {
    state.config.sensors = movieNight(state.selection);
  }
  await busy('Saving…', () => saveConfig({ persist: true }));
  if (!state.error) {
    homebridge.toast.success('Restart Homebridge (or this plugin\'s child bridge) to add the sensors to Apple Home.', 'Saved');
    state.tab = 'sensors';
    go('main');
  }
}

async function refreshFromPlex() {
  await busy('Refreshing from Plex…', async () => {
    state.status = await request('/status');
    state.discovery = await request('/discover', { url: state.config.server.url });
  });
}

/* ---------- views ---------- */

function render() {
  const views = { loading, signin, server, choose, template, main };
  root.innerHTML = `${(views[state.view] ?? loading)()}${footer()}`;
  homebridge.fixScrollHeight?.();
}

function loading() {
  return `<div class="im-hero"><img src="icon.svg" alt=""><p class="im-lead">Loading Intermission…</p></div>`;
}

function notices() {
  return `${state.busy ? `<div class="im-card text-center"><span class="spinner-border spinner-border-sm me-2"></span>${escape(state.busy)}</div>` : ''}
    ${state.error ? `<div class="alert alert-danger" role="alert">${escape(state.error)}</div>` : ''}`;
}

function signin() {
  const pending = state.signIn;
  const expired = state.status.expired ? '<div class="alert alert-warning">Plex no longer accepts the saved sign-in. Please sign in again.</div>' : '';
  let body;
  if (pending?.mode === 'code') {
    body = `<p class="im-lead">Go to <a href="${escape(pending.linkUrl)}" target="_blank" rel="noopener">plex.tv/link</a> on any device and enter this code:</p>
      <p class="display-5 fw-bold" style="letter-spacing:0.3em">${escape(pending.code)}</p>
      <p class="text-muted"><span class="spinner-border spinner-border-sm me-2"></span>Waiting for Plex…</p>`;
  } else if (pending) {
    body = `<p class="im-lead">Finish signing in in the Plex window. This page continues on its own.</p>
      <p class="text-muted"><span class="spinner-border spinner-border-sm me-2"></span>Waiting for Plex…</p>
      <p><a href="${escape(pending.authUrl)}" target="_blank" rel="noopener">Open the Plex sign-in page</a> if no window appeared.</p>`;
  } else {
    body = `<p class="im-lead">Turn Plex playback into Apple Home sensors: lights down when a movie starts, up slowly when the credits roll, quicker when you pause.</p>
      <button class="btn btn-im btn-lg" data-action="signin-browser" ${state.busy ? 'disabled' : ''}>Sign in with Plex</button>
      <p class="mt-3"><button class="im-link" data-action="signin-code">Use a code instead</button></p>`;
  }
  return `<div class="im-hero"><img src="icon.svg" alt=""><h4 class="mt-2">Intermission for Plex</h4>${expired}${body}</div>
    ${notices()}
    <p class="text-center text-muted small">Your Plex sign-in is stored only on this Homebridge, readable by Homebridge alone.</p>`;
}

function stepHeader(number, title) {
  return `<div class="im-step mt-2">Step ${number} of 3</div><h5 class="mb-3">${title}</h5>`;
}

function server() {
  const list = state.servers.map((s) => `<button class="im-pick mb-2" data-action="select-server" data-id="${escape(s.id)}">
      ${deviceIcon({ product: 'Plex Media Server' })}<strong>${escape(s.name)}</strong><small>${s.owned ? 'Your server' : 'Shared with you'}</small>
    </button>`).join('');
  return `${stepHeader(1, 'Choose your Plex server')}${notices()}
    ${state.busy ? '' : `<div class="im-grid">${list}</div>`}
    ${!state.busy && state.servers.length === 0 ? '<p class="text-muted">No servers found on this Plex account.</p>' : ''}
    ${state.error ? '<button class="btn btn-outline-secondary mt-2" data-action="reload-servers">Try again</button>' : ''}`;
}

function plexPassNotice() {
  if (state.status.plexPass !== false) {
    return '';
  }
  return `<div class="im-card im-banner mb-3"><strong>No Plex Pass on this account.</strong>
    Intermission still works: pause, resume and stop are instant, and play is noticed within about 10 seconds.
    Credits use markers already on your server, or 95% of the runtime when there are none.
    Events such as "Marked as watched" and "Added to a library" need Plex Pass.</div>`;
}

function choose() {
  if (state.busy || !state.discovery) {
    return `${stepHeader(2, 'Choose what Intermission watches')}${notices()}`;
  }
  const sel = state.selection;
  const has = (items, id, key = 'id') => items.some((item) => (typeof item === 'string' ? item : item[key]) === id);
  const players = state.discovery.players.map((p) => `<button class="im-pick" data-action="toggle-player" data-id="${escape(p.id)}" ${pressed(has(sel.players, p.id))}>
      ${deviceIcon(p)}<strong>${escape(p.name)}</strong>
      <small>${escape([p.product, p.plays ? `${p.plays} ${p.plays === 1 ? 'play' : 'plays'}` : ''].filter(Boolean).join(' · '))}</small>
      ${p.playingNow ? '<span class="im-live">● Playing now</span>' : ''}
    </button>`).join('');
  const users = state.discovery.users.map((u) => `<button class="im-chip" data-action="toggle-user" data-id="${escape(u.name)}" ${pressed(sel.users.includes(u.name))}>${escape(u.name)}</button>`).join('');
  const libraries = state.discovery.libraries.map((l) => `<button class="im-chip" data-action="toggle-library" data-id="${escape(l.id)}" ${pressed(has(sel.libraries, l.id))}>${escape(l.title)}</button>`).join('');
  return `${stepHeader(2, 'Choose what Intermission watches')}${plexPassNotice()}${notices()}
    <h6>Players</h6><p class="text-muted small">The players in the room with the lights. Most used first.</p>
    <div class="im-grid mb-4">${players || '<p class="text-muted">No players found yet. Play something on the TV, then Refresh.</p>'}</div>
    <h6>People</h6><p class="text-muted small">Leave all off to react to anyone.</p>
    <div class="im-chips mb-4">${users || '<span class="text-muted small">Only you.</span>'}</div>
    <h6>Libraries</h6><p class="text-muted small">Leave all off to react to everything.</p>
    <div class="im-chips mb-4">${libraries}</div>
    <div class="d-flex gap-2">
      <button class="btn btn-im" data-action="to-template">Next</button>
      <button class="btn btn-outline-secondary" data-action="refresh-choose">Refresh</button>
    </div>`;
}

function template() {
  const items = MOVIE_NIGHT.map((s) => `<li><strong>${escape(s.name)}</strong>: ${escape(s.why)}</li>`).join('');
  return `${stepHeader(3, 'Start with a suggestion')}${notices()}
    <button class="im-card im-template" data-action="pick-template" data-id="movie-night" ${pressed(state.template === 'movie-night')}>
      <strong>Movie Night</strong> <span class="im-badge on ms-1">Suggested</span>
      <ul>${items}</ul>
    </button>
    <button class="im-card im-template" data-action="pick-template" data-id="scratch" ${pressed(state.template === 'scratch')}>
      <strong>Start from scratch</strong>
      <div class="text-muted small mt-1">An empty board. Add your own sensors.</div>
    </button>
    <div class="d-flex gap-2 mt-2">
      <button class="btn btn-im" data-action="finish" ${state.busy ? 'disabled' : ''}>Create sensors</button>
      <button class="btn btn-outline-secondary" data-action="back-choose">Back</button>
    </div>`;
}

function main() {
  const tabs = { sensors: 'Sensors', recipes: 'Recipes & Notes', advanced: 'Advanced' };
  const nav = Object.entries(tabs).map(([id, label]) => `<li class="nav-item">
      <button class="nav-link ${state.tab === id ? 'active' : ''}" data-action="tab" data-id="${id}">${label}</button></li>`).join('');
  const content = { sensors: sensorsTab, recipes: recipesTab, advanced: advancedTab }[state.tab]();
  const pass = state.status.plexPass === undefined ? '' : `<span class="im-badge ${state.status.plexPass ? 'on' : ''}">${state.status.plexPass ? 'Plex Pass' : 'No Plex Pass'}</span>`;
  return `<div class="im-header">
      <img src="icon.svg" alt="">
      <div class="im-who"><strong>${escape(state.config.server?.name ?? 'Plex')}</strong><br>
        <small>Signed in as ${escape(state.status.username ?? 'Plex user')}</small></div>
      ${pass}
      <button class="btn btn-sm btn-outline-secondary" data-action="refresh" ${state.busy ? 'disabled' : ''}>Refresh from Plex</button>
    </div>
    ${state.status.signedIn ? '' : '<div class="alert alert-warning">Signed out. <button class="im-link" data-action="to-signin">Sign in again</button></div>'}
    ${notices()}
    <ul class="nav nav-tabs mb-3">${nav}</ul>${content}`;
}

function sensorsTab() {
  const sel = selection();
  const cards = state.config.sensors.map((sensor, index) => {
    const type = SENSOR_TYPES[sensor.type] ?? SENSOR_TYPES.occupancy;
    const badge = needsPlexPass(sensor) && state.status.plexPass === false ? '<span class="im-badge ms-2">Needs Plex Pass</span>' : '';
    const open = state.editing === sensor.id;
    return `<div class="im-card im-sensor" draggable="${open ? 'false' : 'true'}" data-index="${index}">
      <div class="im-kind" aria-hidden="true">${type.glyph}</div>
      <div class="im-body">
        <div class="d-flex align-items-center flex-wrap gap-1">
          <strong>${escape(sensor.name)}</strong><span class="text-muted small ms-2">${escape(type.label)}</span>${badge}
          <span class="ms-auto">
            <button class="btn btn-sm btn-link" data-action="edit" data-id="${escape(sensor.id)}">${open ? 'Done' : 'Edit'}</button>
          </span>
        </div>
        <div class="im-summary">${escape(summarize(sensor, sel))}</div>
        ${open ? editor(sensor, sel) : ''}
      </div>
    </div>`;
  }).join('');
  return `${webhookNotice()}
    ${cards || '<p class="text-muted">No sensors yet.</p>'}
    <div class="d-flex flex-wrap gap-2 mt-2">
      <button class="btn btn-im" data-action="add" data-type="occupancy">Add state sensor</button>
      <button class="btn btn-outline-secondary" data-action="add" data-type="button">Add button</button>
      ${state.config.sensors.length === 0 ? '<button class="btn btn-outline-secondary" data-action="add-template">Add Movie Night</button>' : ''}
    </div>
    <p class="text-muted small mt-3">Drag cards to reorder. Changes apply after you press Save and restart Homebridge. Renaming keeps your Home automations.</p>`;
}

function editor(sensor, sel) {
  const chips = (action, values, chosen, label = (v) => v, disabled = () => false) => values.map((v) => {
    const id = typeof v === 'string' ? v : v.id;
    return `<button class="im-chip" data-action="${action}" data-id="${escape(id)}" ${pressed(chosen.includes(id))} ${disabled(id) ? 'disabled' : ''}>${escape(label(v))}</button>`;
  }).join('');
  const types = Object.entries(SENSOR_TYPES).map(([id, t]) => `<option value="${id}" ${sensor.type === id ? 'selected' : ''}>${t.label}</option>`).join('');
  const conditions = Object.entries(CONDITIONS).map(([id, label]) => `<option value="${id}" ${sensor.state === id ? 'selected' : ''}>${label}</option>`).join('');
  const isState = SENSOR_TYPES[sensor.type]?.state;
  const players = [...sel.players, ...(state.discovery?.players ?? []).filter((p) => !sel.players.some((s) => s.id === p.id)).map(playerRef)];
  const users = [...new Set([...sel.users, ...(state.discovery?.users ?? []).map((u) => u.name)])];
  const libraries = [...sel.libraries, ...(state.discovery?.libraries ?? []).filter((l) => !sel.libraries.some((s) => s.id === l.id))];
  const noPass = state.status.plexPass === false;
  return `<div class="im-editor" data-sensor="${escape(sensor.id)}">
    <div class="row g-2">
      <div class="col-sm-6"><label class="im-label" for="im-name">Name in Apple Home</label>
        <input id="im-name" class="form-control" data-field="name" value="${escape(sensor.name)}" maxlength="64"></div>
      <div class="col-sm-6"><label class="im-label" for="im-type">Type</label>
        <select id="im-type" class="form-select" data-field="type">${types}</select></div>
    </div>
    ${isState
      ? `<label class="im-label" for="im-state">On while</label><select id="im-state" class="form-select" data-field="state">${conditions}</select>`
      : `<label class="im-label">Pressed when</label><div class="im-chips">${chips('toggle-event', Object.keys(EVENTS), sensor.events ?? [],
        (e) => `${EVENTS[e].label}${EVENTS[e].plexPass ? ' ★' : ''}`, (e) => noPass && EVENTS[e].plexPass)}</div>
        <div class="im-pp mt-1">★ needs Plex Pass</div>`}
    <label class="im-label">Players <span class="fw-normal">(none means any)</span></label>
    <div class="im-chips">${chips('toggle-filter-players', players, sensor.filters.players, (p) => p.name) || '<span class="small text-muted">Refresh to find players.</span>'}</div>
    <label class="im-label">People <span class="fw-normal">(none means anyone)</span></label>
    <div class="im-chips">${chips('toggle-filter-users', users, sensor.filters.users) || '<span class="small text-muted">Only you.</span>'}</div>
    <label class="im-label">Libraries <span class="fw-normal">(none means all)</span></label>
    <div class="im-chips">${chips('toggle-filter-libraries', libraries, sensor.filters.libraries, (l) => l.title)}</div>
    <label class="im-label">Media types <span class="fw-normal">(none means all)</span></label>
    <div class="im-chips">${chips('toggle-filter-mediaTypes', Object.keys(MEDIA_TYPES), sensor.filters.mediaTypes, (t) => MEDIA_TYPES[t])}</div>
    <div class="d-flex mt-3">
      <button class="btn btn-sm btn-outline-danger" data-action="delete" data-id="${escape(sensor.id)}">Remove sensor</button>
    </div>
  </div>`;
}

function webhookNotice() {
  if (state.status.plexPass !== true || state.config.webhookAdded) {
    return '';
  }
  const port = state.config.webhook?.port ?? DEFAULT_WEBHOOK_PORT;
  const url = state.webhookPath ? `http://${location.hostname}:${port}${state.webhookPath}` : '';
  return `<div class="im-card im-banner mb-3">
    <strong>Add the Intermission webhook to Plex</strong> for instant play detection and the Plex Pass events.
    ${url ? `<ol class="mb-2 mt-2 small">
        <li>In Plex Web, open Settings, then Webhooks, then Add Webhook.</li>
        <li>Paste <code>${escape(url)}</code> and save.</li></ol>
      <div class="d-flex gap-2"><button class="btn btn-sm btn-im" data-action="copy-webhook" data-url="${escape(url)}">Copy address</button>
      <button class="btn btn-sm btn-outline-secondary" data-action="webhook-done">I've added it</button></div>`
      : '<div class="mt-2"><button class="btn btn-sm btn-im" data-action="show-webhook">Show me how</button></div>'}
  </div>`;
}

function recipesTab() {
  return `<div class="im-recipe">
    <p class="text-muted">Intermission makes the sensors. Apple Home turns them into light changes. These use the Movie Night sensors.</p>
    <div class="im-card"><h6>Lights down when the movie starts</h6><ol>
      <li>In the Home app, tap <strong>+</strong>, then <strong>Add Automation</strong>, then <strong>A Sensor Detects Something</strong>.</li>
      <li>Choose <strong>Movie Playing</strong>, then <strong>Detects Occupancy</strong>.</li>
      <li>Choose your lights and set them dim, or pick a scene.</li></ol></div>
    <div class="im-card"><h6>Lights up quickly on pause</h6><ol>
      <li>Add an automation: <strong>An Accessory is Controlled</strong>, then <strong>Movie Paused</strong>, <strong>Single Press</strong>.</li>
      <li>Set the lights to a comfortable level.</li></ol></div>
    <div class="im-card"><h6>Slow fade up at the credits</h6>
      <p class="small text-muted mb-2">Apple Home has no fade-time setting, so the fade is a short shortcut that steps the lights up.</p><ol>
      <li>Add an automation on <strong>Credits Rolling</strong>, <strong>Single Press</strong>, choose any light, then scroll down and tap <strong>Convert To Shortcut</strong>.</li>
      <li>Replace the steps with <strong>Repeat 10 times</strong>, containing: <strong>Get the state of Movie Playing</strong>; <strong>If</strong> it is detected, <strong>Stop This Shortcut</strong>; set the lights' brightness up by 10%; <strong>Wait 6 seconds</strong>.</li>
      <li>That brings the lights up over a minute, and stops if you rewind and keep watching.</li></ol></div>
    <div class="im-card"><h6>Lights back on when it ends</h6><ol>
      <li>Add an automation on <strong>Movie Stopped</strong>, <strong>Single Press</strong>, and set your normal lighting.</li></ol></div>
    <h6 class="mt-4">Notes</h6>
    <ul class="small">
      <li>Credits start at the first credits marker by default, so mid-credits scenes don't leave you in the dark. Change it in Advanced.</li>
      <li>Rewinding a few seconds after resuming won't flicker the lights. Rewinding further than the re-arm distance ends the credits state.</li>
      <li>Autoplaying the next episode isn't a stop.</li>
      <li>Renaming a sensor here keeps the automations that use it. Removing it removes it from Apple Home.</li>
      <li>Intermission only reacts to the players, people and libraries you choose on each sensor.</li>
    </ul></div>`;
}

function advancedTab() {
  const timing = state.config.timing ?? {};
  const fields = TIMING_FIELDS.map((f) => `<div class="im-field">
      <label for="im-${f.key}"><strong>${f.label}</strong><small>${f.help} ${f.min} to ${f.max} ${f.unit}.</small></label>
      <div class="input-group input-group-sm"><input id="im-${f.key}" type="number" class="form-control" data-timing="${f.key}"
        min="${f.min}" max="${f.max}" value="${timingValue(timing, f)}"><span class="input-group-text">${f.unit}</span></div>
    </div>`).join('');
  const fallback = timing.fallbackPercent === undefined ? 'auto' : (timing.fallbackPercent === null ? 'off' : 'percent');
  const webhook = state.config.webhook ?? {};
  return `<div class="im-card im-banner mb-3">These rarely need changing. The defaults suit most setups.</div>
    <div class="im-card">
      <div class="im-field">
        <label for="im-first"><strong>Start at the first credits marker</strong><small>Includes mid-credits scenes. Off waits for the final marker.</small></label>
        <div class="form-check form-switch"><input id="im-first" class="form-check-input" type="checkbox" data-toggle="firstCreditsMarker" ${timing.firstCreditsMarker === false ? '' : 'checked'}></div>
      </div>
      <div class="im-field">
        <label for="im-fallback"><strong>When an item has no credits marker</strong><small>Automatic uses 95% of the runtime without Plex Pass, and nothing with Plex Pass.</small></label>
        <div><select id="im-fallback" class="form-select form-select-sm" data-fallback>
          <option value="auto" ${fallback === 'auto' ? 'selected' : ''}>Automatic</option>
          <option value="off" ${fallback === 'off' ? 'selected' : ''}>Do nothing</option>
          <option value="percent" ${fallback === 'percent' ? 'selected' : ''}>Percentage</option></select>
          ${fallback === 'percent' ? `<div class="input-group input-group-sm mt-1"><input type="number" class="form-control" min="50" max="99" data-fallback-percent value="${timing.fallbackPercent}"><span class="input-group-text">%</span></div>` : ''}
        </div>
      </div>
      ${fields}
    </div>
    <div class="im-card">
      <div class="im-field">
        <label for="im-webhook"><strong>Receive Plex webhooks</strong><small>Needs Plex Pass. Makes play detection instant.</small></label>
        <div class="form-check form-switch"><input id="im-webhook" class="form-check-input" type="checkbox" data-webhook-enabled ${webhook.enabled === false ? '' : 'checked'}></div>
      </div>
      <div class="im-field">
        <label for="im-port"><strong>Webhook port</strong><small>Change it only if another app uses ${DEFAULT_WEBHOOK_PORT}. 1024 to 65535.</small></label>
        <input id="im-port" type="number" class="form-control form-control-sm" min="1024" max="65535" data-webhook-port value="${webhook.port ?? DEFAULT_WEBHOOK_PORT}">
      </div>
      <div class="im-field">
        <label for="im-detailed"><strong>Detailed logging</strong><small>Logs every event and timer decision. Turn on when reporting a problem.</small></label>
        <div class="form-check form-switch"><input id="im-detailed" class="form-check-input" type="checkbox" data-detailed ${state.config.detailedLogging ? 'checked' : ''}></div>
      </div>
    </div>
    <div class="d-flex flex-wrap gap-2">
      <button class="btn btn-outline-secondary" data-action="reset-advanced">Reset to defaults</button>
      <button class="btn btn-outline-secondary" data-action="redo-setup">Change players and libraries</button>
      <button class="btn btn-outline-danger ms-auto" data-action="signout">Sign out of Plex</button>
    </div>`;
}

function footer() {
  const repo = 'https://github.com/maxrogers/homebridge-plex-intermission';
  return `<div class="im-footer">
    <a href="${repo}" target="_blank" rel="noopener">GitHub</a> ·
    <a href="${repo}/issues/new?template=bug_report.yml" target="_blank" rel="noopener">Report a bug</a> ·
    <a href="${repo}/issues/new?template=feature_request.yml" target="_blank" rel="noopener">Suggest a feature</a> ·
    <a href="https://ko-fi.com/maxrogers" target="_blank" rel="noopener">Buy me a coffee</a>
  </div>`;
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

function toggleRef(list, item) {
  const index = list.findIndex((existing) => existing.id === item.id);
  if (index === -1) {
    list.push(item);
  } else {
    list.splice(index, 1);
  }
}

const editingSensor = () => state.config.sensors.find((s) => s.id === state.editing);

async function changed() {
  render();
  await saveConfig();
}

const actions = {
  'signin-browser': () => beginSignIn('browser'),
  'signin-code': () => beginSignIn('code'),
  'to-signin': () => go('signin'),
  'reload-servers': () => loadServers(),
  'select-server': (el) => selectServer(el.dataset.id),
  'toggle-player': (el) => { toggleRef(state.selection.players, playerRef(state.discovery.players.find((p) => p.id === el.dataset.id))); render(); },
  'toggle-user': (el) => { toggle(state.selection.users, el.dataset.id); render(); },
  'toggle-library': (el) => { toggleRef(state.selection.libraries, state.discovery.libraries.find((l) => l.id === el.dataset.id)); render(); },
  'refresh-choose': () => loadDiscovery('choose'),
  'to-template': () => (state.config.sensors.length > 0 ? finishSetup() : go('template')),
  'back-choose': () => go('choose'),
  'pick-template': (el) => { state.template = el.dataset.id; render(); },
  finish: () => finishSetup(),
  tab: (el) => { state.tab = el.dataset.id; render(); },
  refresh: () => refreshFromPlex(),
  edit: (el) => { state.editing = state.editing === el.dataset.id ? undefined : el.dataset.id; render(); },
  add: (el) => {
    const sensor = newSensor(el.dataset.type);
    sensor.filters.players = selection().players.map((p) => p.id);
    state.config.sensors.push(sensor);
    state.editing = sensor.id;
    return changed();
  },
  'add-template': () => { state.config.sensors = movieNight(selection()); return changed(); },
  delete: (el) => {
    const sensor = state.config.sensors.find((s) => s.id === el.dataset.id);
    if (sensor && window.confirm(`Remove "${sensor.name}"? It will also be removed from Apple Home, with any automations that use it.`)) {
      state.config.sensors = state.config.sensors.filter((s) => s !== sensor);
      state.editing = undefined;
      return changed();
    }
    return undefined;
  },
  'toggle-event': (el) => { toggle(editingSensor().events, el.dataset.id); return changed(); },
  'toggle-filter-players': (el) => { toggle(editingSensor().filters.players, el.dataset.id); return changed(); },
  'toggle-filter-users': (el) => { toggle(editingSensor().filters.users, el.dataset.id); return changed(); },
  'toggle-filter-libraries': (el) => { toggle(editingSensor().filters.libraries, el.dataset.id); return changed(); },
  'toggle-filter-mediaTypes': (el) => { toggle(editingSensor().filters.mediaTypes, el.dataset.id); return changed(); },
  'show-webhook': async () => { state.webhookPath = (await request('/webhook')).path; render(); },
  'copy-webhook': async (el) => {
    try {
      await navigator.clipboard.writeText(el.dataset.url);
      homebridge.toast.success('Webhook address copied.');
    } catch {
      homebridge.toast.info(el.dataset.url, 'Copy this address');
    }
  },
  'webhook-done': () => { state.config.webhookAdded = true; return changed(); },
  'reset-advanced': () => {
    delete state.config.timing;
    delete state.config.webhook;
    delete state.config.detailedLogging;
    homebridge.toast.info('Advanced settings reset. Press Save to keep them.');
    return changed();
  },
  'redo-setup': async () => {
    await loadDiscovery('choose');
  },
  signout: async () => {
    if (window.confirm('Sign out of Plex? Your sensors stay in Apple Home but stop changing until you sign in again.')) {
      await busy('Signing out…', async () => {
        state.status = await request('/signout');
      });
      go('signin');
    }
  },
};

root.addEventListener('click', (event) => {
  const el = event.target.closest('[data-action]');
  if (!el || !root.contains(el)) {
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
  const sensor = editingSensor();
  const field = el.dataset.field;
  if (sensor && field) {
    if (field === 'name') {
      sensor.name = el.value.trim() || sensor.name;
    } else if (field === 'type') {
      const wasState = SENSOR_TYPES[sensor.type].state;
      sensor.type = el.value;
      if (SENSOR_TYPES[sensor.type].state && !wasState) {
        sensor.state = 'playing';
        delete sensor.events;
      } else if (!SENSOR_TYPES[sensor.type].state && wasState) {
        sensor.events = ['play'];
        delete sensor.state;
      }
    } else if (field === 'state') {
      sensor.state = el.value;
    }
    void changed();
    return;
  }
  const config = state.config;
  if (el.dataset.timing) {
    config.timing = setTiming(config.timing ?? {}, TIMING_FIELDS.find((f) => f.key === el.dataset.timing), el.value);
  } else if (el.dataset.toggle === 'firstCreditsMarker') {
    config.timing = { ...config.timing, firstCreditsMarker: el.checked };
    if (el.checked) {
      delete config.timing.firstCreditsMarker;
    }
  } else if (el.hasAttribute('data-fallback')) {
    config.timing = { ...config.timing };
    if (el.value === 'auto') {
      delete config.timing.fallbackPercent;
    } else {
      config.timing.fallbackPercent = el.value === 'off' ? null : 95;
    }
  } else if (el.hasAttribute('data-fallback-percent')) {
    config.timing = { ...config.timing, fallbackPercent: Math.min(99, Math.max(50, Math.round(Number(el.value) || 95))) };
  } else if (el.hasAttribute('data-webhook-enabled')) {
    config.webhook = { ...config.webhook, enabled: el.checked };
  } else if (el.hasAttribute('data-webhook-port')) {
    const port = Math.round(Number(el.value));
    config.webhook = { ...config.webhook, port: port >= 1024 && port <= 65535 ? port : DEFAULT_WEBHOOK_PORT };
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
