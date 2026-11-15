// A small world for scenario tests: a fake Plex Media Server, a fake plex.tv, and the real platform
// running on Homebridge's own API class, so sensors are read exactly as Homebridge would publish them.
import { rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WebSocketServer } from 'ws';

import { HomebridgeAPI } from '../node_modules/homebridge/dist/api.js';
import { User } from '../node_modules/homebridge/dist/user.js';
import { NotificationStream } from '../dist/plex/notifications.js';
import { PlexTv } from '../dist/plex/plex-tv.js';
import { IntermissionPlatform } from '../dist/platform.js';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `check` returns something truthy, or fails with `what`. */
export async function until(check, what, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await sleep(15);
  }
}

const json = (response, body, status = 200) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));

/** Players as Plex reports them. `address` and `local` are what the server sees. */
export const PLAYERS = {
  tv: { id: 'TV-PLEX', title: 'Apple TV', product: 'Plex for Apple TV', platform: 'tvOS', address: '10.0.0.20', local: true },
  infuse: { id: 'TV-INFUSE', title: 'Apple TV', product: 'Infuse', platform: 'tvOS', address: '10.0.0.20', local: true },
  bedroom: { id: 'BED-PLEX', title: 'Apple TV', product: 'Plex for Apple TV', platform: 'tvOS', address: '10.0.0.31', local: true },
  phone: { id: 'PHONE', title: 'iPhone', product: 'Plex for iOS', platform: 'iOS', address: '10.0.0.40', local: true },
  web: { id: 'WEB', title: 'Chrome', product: 'Plex Web', platform: 'Chrome', address: '10.0.0.50', local: true },
  away: { id: 'AWAY-TV', title: 'Apple TV', product: 'Plex for Apple TV', platform: 'tvOS', address: '73.14.2.9', local: false },
};

export class FakePlex {
  sessions = new Map();
  sockets = new Set();
  requests = [];
  /** HTTP status to answer everything with, to act out a rejected token or a broken server. */
  failWith = undefined;
  /** Leaves new sessions out of /status/sessions, as Plex sometimes does for a moment. */
  hideSessions = false;
  liveTv = false;
  /** Slows item (marker) reads, as a busy server does. */
  metadataDelayMs = 0;
  nextSessionKey = 1;

  constructor({ id = 'server-1', name = 'Plex', token = 'account-token' } = {}) {
    Object.assign(this, { id, name, token });
    this.libraries = [
      { key: '1', title: 'Movies', type: 'movie', agent: 'tv.plex.agents.movie' },
      { key: '2', title: 'TV Shows', type: 'show', agent: 'tv.plex.agents.series' },
      { key: '3', title: 'Home Videos', type: 'movie', agent: 'com.plexapp.agents.none' },
      { key: '4', title: 'Music', type: 'artist', agent: 'tv.plex.agents.music' },
    ];
    const credits = (start, end) => [{ type: 'credits', startTimeOffset: start, endTimeOffset: end, final: true }];
    this.items = new Map(Object.entries({
      movie: { title: 'Dune', type: 'movie', duration: 600_000, section: '1', Marker: credits(500_000, 600_000) },
      short: { title: 'Short Film', type: 'movie', duration: 60_000, section: '1', Marker: credits(2_000, 60_000) },
      episode: { title: 'Pilot', grandparentTitle: 'Severance', type: 'episode', duration: 300_000, section: '2', Marker: credits(280_000, 300_000) },
      next: { title: 'Half Loop', grandparentTitle: 'Severance', type: 'episode', duration: 300_000, section: '2', Marker: credits(280_000, 300_000) },
      home: { title: 'Birthday', type: 'movie', duration: 60_000, section: '3' },
      song: { title: 'Song', type: 'track', duration: 180_000, section: '4' },
      news: { title: 'News at 6', type: 'episode', duration: 1_800_000, live: true },
    }));
  }

  get url() {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(port = 0) {
    this.http = createServer((request, response) => this.handle(request, response));
    this.ws = new WebSocketServer({ noServer: true });
    this.http.on('upgrade', (request, socket, head) => {
      const token = new URL(request.url, 'http://x').searchParams.get('X-Plex-Token');
      if (this.failWith || token !== this.token) {
        socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return;
      }
      this.ws.handleUpgrade(request, socket, head, (client) => {
        this.sockets.add(client);
        client.on('close', () => this.sockets.delete(client));
      });
    });
    await new Promise((resolve) => this.http.listen(port, '127.0.0.1', resolve));
    this.port = this.http.address().port;
    return this;
  }

  /** Stops answering, as when the server is shut down. `start(port)` brings it back. */
  async stop() {
    for (const socket of this.sockets) {
      socket.terminate();
    }
    this.sockets.clear();
    this.http?.closeAllConnections();
    await new Promise((resolve) => (this.http ? this.http.close(resolve) : resolve()));
    this.http = undefined;
  }

  /** Stops talking without closing anything, as a server that lost power does. */
  freeze() {
    this.frozen = true;
  }

  metadata(key) {
    const item = this.items.get(key);
    const library = this.libraries.find((l) => l.key === item.section);
    const { section, ...rest } = item;
    void section;
    return {
      ratingKey: key, key: `/library/metadata/${key}`, ...rest,
      ...(library ? { librarySectionID: Number(library.key), librarySectionTitle: library.title } : {}),
    };
  }

  position(session) {
    return Math.round(session.state === 'playing' ? session.offset + (Date.now() - session.at) : session.offset);
  }

  handle(request, response) {
    const url = new URL(request.url, 'http://x');
    this.requests.push(url.pathname);
    if (this.failWith) {
      return response.writeHead(this.failWith).end();
    }
    if (url.pathname === '/identity') {
      return json(response, { MediaContainer: { machineIdentifier: this.id, version: '1.43.0' } });
    }
    if (request.headers['x-plex-token'] !== this.token) {
      return response.writeHead(401).end();
    }
    if (url.pathname === '/status/sessions') {
      const listed = this.hideSessions ? [] : [...this.sessions.values()];
      return json(response, { MediaContainer: { Metadata: listed.map((s) => ({
        ...this.metadata(s.key), sessionKey: String(s.sessionKey), viewOffset: this.position(s),
        Player: { machineIdentifier: s.player.id, title: s.player.title, product: s.player.product, platform: s.player.platform, address: s.player.address, local: s.player.local, state: s.state },
        User: { title: s.user },
      })) } });
    }
    if (url.pathname === '/library/sections') {
      return json(response, { MediaContainer: { Directory: this.libraries } });
    }
    if (url.pathname === '/media/providers') {
      return json(response, { MediaContainer: { MediaProvider: this.liveTv ? [{ identifier: 'tv.plex.providers.epg.cloud', protocols: 'livetv' }] : [] } });
    }
    const match = /^\/library\/metadata\/(\w+)$/.exec(url.pathname);
    if (match && this.metadataDelayMs > 0 && !request.delayed) {
      request.delayed = true;
      setTimeout(() => this.handle(request, response), this.metadataDelayMs);
      return undefined;
    }
    if (match) {
      return json(response, { MediaContainer: { Metadata: this.items.has(match[1]) ? [this.metadata(match[1])] : [] } });
    }
    return response.writeHead(404).end();
  }

  notify(session, state = session.state) {
    if (this.frozen) {
      return;
    }
    const message = JSON.stringify({ NotificationContainer: { type: 'playing', size: 1, PlaySessionStateNotification: [{
      sessionKey: String(session.sessionKey), clientIdentifier: session.player.id, ratingKey: session.key, viewOffset: this.position(session), state,
    }] } });
    for (const socket of this.sockets) {
      socket.send(message);
    }
  }

  /** Posts a webhook as Plex does: multipart, with the item's poster on play events. */
  async webhook(event, session, { thumbBytes = 0, serverId = this.id } = {}) {
    if (!this.webhookUrl) {
      return undefined;
    }
    const payload = JSON.stringify({
      event, user: true, owner: true, Account: { title: session?.user }, Server: { uuid: serverId, title: this.name },
      ...(session ? {
        Player: { uuid: session.player.id, title: session.player.title, local: session.player.local, publicAddress: '203.0.113.7' },
        Metadata: { ...this.metadata(session.key), viewOffset: this.position(session) },
      } : {}),
    });
    const boundary = '------------------------plexwebhook';
    const parts = [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="payload"\r\nContent-Type: application/json\r\n\r\n${payload}\r\n`)];
    if (thumbBytes > 0) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="thumb"; filename="thumb.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
        Buffer.alloc(thumbBytes, 0xff), Buffer.from('\r\n'));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const response = await fetch(this.webhookUrl, { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body: Buffer.concat(parts) });
    return response.status;
  }

  /** Starts playback. `webhook` posts media.play first, as with Plex Pass; `notify` sends the websocket report. */
  async play(player, key, { offset = 0, user = 'Steve', webhook = Boolean(this.webhookUrl), notify = true, state = 'playing' } = {}) {
    const session = { player, key, user, state, offset, at: Date.now(), sessionKey: this.nextSessionKey++ };
    this.sessions.set(player.id, session);
    if (webhook) {
      await this.webhook('media.play', session, { thumbBytes: 40_000 });
    }
    if (notify) {
      this.notify(session);
    }
    return session;
  }

  async pause(player) {
    const session = this.sessions.get(player.id);
    Object.assign(session, { offset: this.position(session), at: Date.now(), state: 'paused' });
    this.notify(session);
    await this.webhook('media.pause', session);
  }

  async resume(player) {
    const session = this.sessions.get(player.id);
    Object.assign(session, { at: Date.now(), state: 'playing' });
    this.notify(session);
    await this.webhook('media.resume', session);
  }

  seek(player, offset) {
    const session = this.sessions.get(player.id);
    Object.assign(session, { offset, at: Date.now() });
    this.notify(session);
  }

  /** The app is force-quit or loses power: the session leaves the list and nothing is reported. */
  vanish(player) {
    this.sessions.delete(player.id);
  }

  async stop_(player) {
    const session = this.sessions.get(player.id);
    Object.assign(session, { offset: this.position(session), at: Date.now() });
    this.sessions.delete(player.id);
    this.notify(session, 'stopped');
    await this.webhook('media.stop', session);
  }
}

/** plex.tv as far as the running plugin uses it: the account and its servers. */
export class FakePlexTv {
  plexPass = true;
  /** HTTP status for every request, to act out a rejected sign-in or an outage. */
  failWith = undefined;
  token = 'account-token';
  resources = [];
  requests = [];

  async start() {
    this.http = createServer((request, response) => {
      const url = new URL(request.url, 'http://x');
      this.requests.push(url.pathname);
      if (this.failWith) {
        return response.writeHead(this.failWith).end();
      }
      if (request.headers['x-plex-token'] !== this.token) {
        return response.writeHead(401).end();
      }
      if (url.pathname === '/api/v2/user') {
        return json(response, { id: 1, username: 'steve', title: 'Steve', subscription: { active: this.plexPass } });
      }
      if (url.pathname === '/api/v2/resources') {
        return json(response, this.resources);
      }
      return response.writeHead(404).end();
    });
    await new Promise((resolve) => this.http.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${this.http.address().port}`;
    return this;
  }

  /** Lists a server on the account at the given addresses. */
  lists(plex, urls = [plex.url], { owned = true, accessToken } = {}) {
    this.resources = [...this.resources.filter((r) => r.clientIdentifier !== plex.id), {
      clientIdentifier: plex.id, name: plex.name, provides: 'server', owned, accessToken,
      connections: urls.map((uri) => ({ uri, address: '127.0.0.1', port: Number(new URL(uri).port), protocol: 'http', local: true, relay: false })),
    }];
  }

  async stop() {
    this.http?.closeAllConnections();
    await new Promise((resolve) => (this.http ? this.http.close(resolve) : resolve()));
  }
}

/** A port nothing listens on right now. */
export async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** Fast timing, so scenarios don't wait out the real pause debounce and stop hold. */
export const FAST = { pauseDebounce: 0, stopHold: 0 };

export const sensor = (id, state, extra = {}) => ({ id, name: extra.name ?? id, type: 'occupancy', state, ...extra });

/** The Every State preset. */
export const everyState = (filters = {}) => [
  sensor('playing', 'playing', { name: 'Media Playing', except: ['credits'], filters }),
  sensor('paused', 'paused', { name: 'Media Paused', except: ['credits'], filters }),
  sensor('credits', 'credits', { name: 'Credits Rolling', filters }),
  sensor('idle', 'idle', { name: 'Nothing Playing', filters }),
];

let root;
let storagePathSet = false;

/**
 * Starts the platform as Homebridge would. `previous` is a home from an earlier run, whose cached
 * accessories are handed back first, as after a restart.
 */
export async function startHome(t, { config, plexTv, signedIn = true, serverTokens, previous, stream = {}, players, goneCheckMs }) {
  // Homebridge's storage path can be set once per process, so every home shares it and starts clean.
  root ??= await mkdtemp(join(tmpdir(), 'intermission-world-'));
  const storage = root;
  if (!previous) {
    // A home from the previous test may still be writing its files.
    await rm(join(storage, 'intermission'), { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    await mkdir(join(storage, 'intermission'), { recursive: true });
    if (players) {
      await writeFile(join(storage, 'intermission', 'players.json'), JSON.stringify(players));
    }
    await writeFile(join(storage, 'intermission', 'state.json'), JSON.stringify({ clientIdentifier: 'homebridge-intermission-test', webhookSecret: 'secret0123456789' }));
    if (signedIn) {
      await writeFile(join(storage, 'intermission', 'credentials.json'), JSON.stringify({ accountToken: plexTv?.token ?? 'account-token', username: 'Steve', savedAt: 'now', setupId: 'setup-1', serverTokens }));
    }
  }
  if (!storagePathSet) {
    User.setStoragePath(storage);
    storagePathSet = true;
    process.on('exit', () => rmSync(storage, { recursive: true, force: true }));
  }
  const api = new HomebridgeAPI();
  const lines = [];
  const logger = (level) => (message, ...parameters) => {
    let index = 0;
    lines.push(`${level} ${String(message).replace(/%[sdj]/g, () => String(parameters[index++]))}`);
  };
  const log = Object.assign(logger('info'), { info: logger('info'), warn: logger('warn'), error: logger('error'), debug: logger('debug'), success: logger('info'), log: logger('info'), prefix: 'Intermission' });
  const accessories = new Map((previous?.accessories() ?? []).map((a) => [a.UUID, a]));
  api.on('registerPlatformAccessories', (added) => added.forEach((a) => accessories.set(a.UUID, a)));
  api.on('unregisterPlatformAccessories', (removed) => removed.forEach((a) => accessories.delete(a.UUID)));

  class TestPlatform extends IntermissionPlatform {
    goneCheckMs = goneCheckMs;

    createPlexTv(clientIdentifier) {
      return new PlexTv({ clientIdentifier, baseUrl: plexTv?.url ?? 'http://127.0.0.1:9', timeoutMs: 1_500 });
    }

    createStream(url) {
      return new NotificationStream({ url, log: this.log, minBackoffMs: 30, maxBackoffMs: 60, connectTimeoutMs: 1_000, ...stream });
    }
  }
  // A free webhook port unless the scenario names one, so a running Homebridge or another test run can't hold it.
  const webhook = { port: await freePort(), ...config.webhook };
  const platform = new TestPlatform(log, { platform: 'PlexIntermission', name: 'Intermission', setupId: 'setup-1', timing: FAST, ...config, webhook }, api);
  for (const accessory of accessories.values()) {
    platform.configureAccessory(accessory);
  }
  api.signalFinished();

  const { Service, Characteristic } = api.hap;
  const find = (name) => [...accessories.values()].find((a) => a.displayName === name);
  const home = {
    api, lines, storage,
    accessories: () => [...accessories.values()],
    names: () => [...accessories.values()].map((a) => a.displayName).sort(),
    /** Whether a state sensor is on, whatever its type. */
    on(name) {
      const accessory = find(name);
      if (!accessory) {
        throw new Error(`No sensor named ${name}; there are ${home.names().join(', ')}`);
      }
      const occupancy = accessory.getService(Service.OccupancySensor)?.getCharacteristic(Characteristic.OccupancyDetected).value;
      const motion = accessory.getService(Service.MotionSensor)?.getCharacteristic(Characteristic.MotionDetected).value;
      const contact = accessory.getService(Service.ContactSensor)?.getCharacteristic(Characteristic.ContactSensorState).value;
      return occupancy === 1 || motion === true || contact === 1;
    },
    /** The names of the state sensors that are on, sorted. */
    active: () => home.names().filter((name) => !find(name).getService(Service.StatelessProgrammableSwitch) && home.on(name)),
    /** Counts presses of a button from now on. */
    presses(name) {
      const counter = { count: 0 };
      find(name).getService(Service.StatelessProgrammableSwitch).getCharacteristic(Characteristic.ProgrammableSwitchEvent)
        .on('change', () => { counter.count += 1; });
      return counter;
    },
    logged: (pattern, level) => lines.some((line) => (!level || line.startsWith(level)) && pattern.test(line)),
    problems: () => lines.filter((line) => /^error|Unexpected error|TypeError|ReferenceError|is not a function|Cannot read prop/.test(line)),
    waitLog: (pattern, timeoutMs) => until(() => lines.some((line) => pattern.test(line)), `log line ${pattern}`, timeoutMs),
    waitActive: (names, timeoutMs) => until(() => JSON.stringify(home.active()) === JSON.stringify([...names].sort()), 'sensors', timeoutMs)
      .catch(() => {
        throw new Error(`Expected on: ${[...names].sort().join(', ') || 'none'}; on now: ${home.active().join(', ') || 'none'}\n${lines.slice(-25).join('\n')}`);
      }),
    async shutdown() {
      api.signalShutdown();
      await sleep(30);
    },
  };
  t.after(() => home.shutdown());
  return home;
}

/** A Plex server and plex.tv that know each other, both stopped when the test ends. */
export async function startPlex(t, options = {}) {
  const plex = await new FakePlex(options).start();
  const plexTv = options.plexTv ?? await new FakePlexTv().start();
  plexTv.lists(plex);
  t.after(async () => {
    await plex.stop();
    await plexTv.stop();
  });
  return { plex, plexTv, server: { id: plex.id, name: plex.name, url: plex.url } };
}
