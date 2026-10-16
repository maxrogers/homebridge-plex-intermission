import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DEFAULT_WEBHOOK_PORT, parseConfig } from '../dist/config.js';
import { discover } from '../dist/plex/discovery.js';
import { connectionCandidates, PlexTv } from '../dist/plex/plex-tv.js';
import { PlexHttpError } from '../dist/plex/server.js';
import { Storage } from '../dist/storage.js';
import { silentLog } from './helpers.js';

test('config defaults', () => {
  const config = parseConfig({ platform: 'PlexIntermission' }, silentLog);
  assert.equal(config.name, 'Intermission');
  assert.equal(config.server, undefined);
  assert.deepEqual(config.sensors, []);
  assert.equal(config.webhook.port, DEFAULT_WEBHOOK_PORT);
  assert.equal(config.webhook.enabled, true);
  assert.equal(config.engine.fallbackPercent, null);
  assert.equal(config.fallbackConfigured, false);
  assert.equal(config.safetyResyncMs, 5 * 60_000);
  assert.equal(config.engine.useFirstCreditsMarker, true);
  assert.equal(config.engine.minItemLengthMs, 0);
});

test('config clamps timing to the documented ranges', () => {
  const config = parseConfig({
    timing: { creditsOffset: 500, fallbackPercent: 20, rearmDistance: 1, pauseDebounce: -3, stopHold: 61, minItemLength: 90, safetyResync: 0 },
  }, silentLog);
  assert.equal(config.engine.creditsOffsetMs, 120_000);
  assert.equal(config.engine.fallbackPercent, 50);
  assert.equal(config.fallbackConfigured, true);
  assert.equal(config.engine.rearmDistanceMs, 20_000);
  assert.equal(config.engine.pauseDebounceMs, 0);
  assert.equal(config.engine.stopHoldMs, 60_000);
  assert.equal(config.engine.minItemLengthMs, 90_000);
  assert.equal(config.safetyResyncMs, 0);
  assert.equal(parseConfig({ timing: { fallbackPercent: null } }, silentLog).fallbackConfigured, true);
});

test('config skips invalid sensors with a warning', () => {
  const warnings = [];
  const log = { ...silentLog, warn: (...args) => warnings.push(args) };
  const config = parseConfig({
    sensors: [
      { id: 'a', name: 'Playing', type: 'occupancy' },
      { id: 'a', name: 'Duplicate', type: 'motion' },
      { id: 'b', name: 'No type' },
      { id: 'c', name: 'Credits', type: 'button', events: ['credits.start', 'made.up'] },
      { id: 'd', name: 'Nothing', type: 'button', events: [] },
    ],
  }, log);
  assert.deepEqual(config.sensors.map((s) => s.id), ['a', 'c', 'd']);
  assert.equal(config.sensors[0].state, 'playing');
  assert.deepEqual(config.sensors[1].events, ['credits.start']);
  assert.equal(warnings.length, 3);
});

test('storage keeps credentials private and state stable', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'intermission-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storage = new Storage(directory);

  assert.equal(await storage.readCredentials(), undefined);
  await storage.writeCredentials({ accountToken: 'secret', savedAt: 'now' });
  assert.equal((await storage.readCredentials()).accountToken, 'secret');
  if (process.platform !== 'win32') {
    assert.equal((await stat(join(storage.directory, 'credentials.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(storage.directory)).mode & 0o777, 0o700);
  }

  const first = await storage.state();
  assert.match(first.clientIdentifier, /^homebridge-intermission-/);
  assert.match(first.webhookSecret, /^[0-9a-f]{32}$/);
  assert.deepEqual(await new Storage(directory).state(), first);

  await storage.deleteCredentials();
  assert.equal(await storage.readCredentials(), undefined);
  assert.doesNotMatch(await readFile(join(storage.directory, 'state.json'), 'utf8'), /secret"/);
});

async function mockPlexTv(t, routes) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, headers: request.headers });
    const route = routes[`${request.method} ${request.url.split('?')[0]}`];
    if (!route) {
      response.writeHead(404).end();
      return;
    }
    const [status, body, type = 'application/json'] = route(request);
    response.writeHead(status, { 'Content-Type': type }).end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const plexTv = new PlexTv({ clientIdentifier: 'client-1', baseUrl: `http://127.0.0.1:${server.address().port}` });
  return { plexTv, requests };
}

test('plex.tv sign-in, account and resources', async (t) => {
  const { plexTv, requests } = await mockPlexTv(t, {
    'POST /api/v2/pins': () => [201, { id: 5, code: 'abcd' }],
    'GET /api/v2/pins/5': () => [200, { authToken: 'token-1' }],
    'GET /api/v2/user': (request) => (request.headers['x-plex-token'] === 'token-1'
      ? [200, { id: 1, username: 'steve', title: 'Steve', subscription: { active: true } }]
      : [401, {}]),
    'GET /api/v2/resources': () => [200, [
      { name: 'Player', clientIdentifier: 'p', provides: 'player' },
      {
        name: 'Unraid', clientIdentifier: 'srv', provides: 'server', owned: true, accessToken: 'server-token',
        connections: [
          { uri: 'https://relay.plex.direct:8443', address: '1.2.3.4', port: 8443, protocol: 'https', local: false, relay: true },
          { uri: 'https://203-0-113-1.plex.direct:32400', address: '203.0.113.1', port: 32400, protocol: 'https', local: false, relay: false },
          { uri: 'https://10-0-0-2.plex.direct:32400', address: '10.0.0.2', port: 32400, protocol: 'https', local: true, relay: false },
        ],
      },
    ]],
    'GET /devices.xml': () => [200, `<MediaContainer>
      <Device name="Living Room &amp; Co" product="Plex for Apple TV" platform="tvOS" device="Apple TV" clientIdentifier="ATV" provides="client,player" lastSeenAt="1700000000"/>
      <Device name="Server" clientIdentifier="srv" provides="server"/>
    </MediaContainer>`, 'application/xml'],
  });

  const pin = await plexTv.createPin(true);
  assert.deepEqual(pin, { id: 5, code: 'abcd' });
  assert.match(plexTv.authUrl(pin), /^https:\/\/app\.plex\.tv\/auth#\?clientID=client-1&code=abcd/);
  assert.equal(await plexTv.checkPin(pin), 'token-1');
  assert.deepEqual(await plexTv.user('token-1'), { id: 1, username: 'steve', title: 'Steve', plexPass: true });
  await assert.rejects(plexTv.user('wrong'), (error) => error instanceof PlexHttpError && error.status === 401 && !error.message.includes('wrong'));

  const [server] = await plexTv.servers('token-1');
  assert.equal(server.id, 'srv');
  assert.deepEqual(connectionCandidates(server), [
    'https://10-0-0-2.plex.direct:32400',
    'http://10.0.0.2:32400',
    'https://203-0-113-1.plex.direct:32400',
    'https://relay.plex.direct:8443',
  ]);

  assert.deepEqual(await plexTv.devices('token-1'), [{
    id: 'ATV', name: 'Living Room & Co', product: 'Plex for Apple TV', platform: 'tvOS', device: 'Apple TV', lastSeenAt: 1_700_000_000_000,
  }]);
  assert.ok(requests.every((request) => request.headers['x-plex-client-identifier'] === 'client-1'));
  assert.ok(requests.every((request) => !request.url.includes('token-1')), 'tokens are sent as headers');
});

test('discovery merges sources, ranks players and survives failures', async () => {
  const plexTv = {
    devices: async () => [
      { id: 'ATV', name: 'Living Room', platform: 'tvOS', lastSeenAt: 1_000 },
      { id: 'PHONE', name: 'iPhone', platform: 'iOS', lastSeenAt: 5_000 },
      { id: 'OLD', name: 'Old Roku', lastSeenAt: 9_000 },
    ],
  };
  const server = {
    devices: async () => [{ id: '1', clientIdentifier: 'ATV', name: 'Apple TV' }, { id: '2', clientIdentifier: 'PHONE', name: 'iPhone' }],
    history: async () => [
      { deviceId: '1', accountId: '1', viewedAt: 100 },
      { deviceId: '1', accountId: '1', viewedAt: 200 },
      { deviceId: '2', accountId: '1', viewedAt: 300 },
    ],
    sessions: async () => [{ playerId: 'BEDROOM', playerTitle: 'Bedroom TV', product: 'Plex for LG', media: {} }],
    accounts: async () => {
      throw new Error('offline');
    },
    libraries: async () => [{ id: '1', title: 'Movies', type: 'movie' }, { id: '9', title: 'Other', type: 'mixed' }],
  };
  const result = await discover(server, plexTv, 'token');
  assert.deepEqual(result.players.map((p) => p.id), ['BEDROOM', 'ATV', 'PHONE', 'OLD']);
  assert.equal(result.players[1].name, 'Living Room', 'the account name wins over the server one');
  assert.equal(result.players[1].plays, 2);
  assert.equal(result.players[0].playingNow, true);
  assert.deepEqual(result.users, []);
  assert.deepEqual(result.libraries.map((l) => l.id), ['1']);
});
