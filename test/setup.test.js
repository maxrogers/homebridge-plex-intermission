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
  assert.deepEqual(config.servers, []);
  assert.deepEqual(config.sensors, []);
  assert.equal(config.webhook.port, DEFAULT_WEBHOOK_PORT);
  assert.equal(config.webhook.enabled, true);
  assert.equal(config.engine.fallbackPercent, 95, 'on for everyone, movies and episodes only');
  assert.equal(config.safetyResyncMs, 5 * 60_000);
  assert.equal(config.engine.creditsMode, 'scenes');
  assert.equal(config.engine.minItemLengthMs, 0);
});

test('config clamps timing to the documented ranges', () => {
  const config = parseConfig({
    timing: { creditsOffset: 500, fallbackPercent: 20, rearmDistance: 1, pauseDebounce: -3, stopHold: 61, minItemLength: 90, safetyResync: 0 },
  }, silentLog);
  assert.equal(config.engine.creditsOffsetMs, 120_000);
  assert.equal(config.engine.fallbackPercent, 50);
  assert.equal(config.engine.rearmDistanceMs, 20_000);
  assert.equal(config.engine.pauseDebounceMs, 0);
  assert.equal(config.engine.stopHoldMs, 60_000);
  assert.equal(config.engine.minItemLengthMs, 90_000);
  assert.equal(config.safetyResyncMs, 0);
  assert.equal(parseConfig({ timing: { fallbackPercent: null } }, silentLog).engine.fallbackPercent, null, 'null turns it off');
  const legacy = parseConfig({ server: { id: 'a', name: 'Old', url: 'http://a' } }, silentLog);
  assert.deepEqual(legacy.servers, [{ id: 'a', name: 'Old', url: 'http://a' }], 'single-server configs still load');
  const many = parseConfig({ servers: [{ id: 'a', url: 'http://a' }, { id: 'a', url: 'http://b' }, { id: 'b', url: 'http://c' }, { url: 'x' }] }, silentLog);
  assert.deepEqual(many.servers.map((s) => s.id), ['a', 'b']);
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
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) {
      text += chunk;
    }
    request.body = text;
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
  let webhookList = ['https://example.com/hook'];
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
    'GET /api/home/users': () => [200, `<MediaContainer>
      <User id="1" title="Steve" username="steve" admin="1" restricted="0"/>
      <User id="2" title="Kids &amp; Co" username="" admin="0" restricted="1"/>
    </MediaContainer>`, 'application/xml'],
    'GET /api/v2/user/webhooks': () => [200, webhookList.map((url) => ({ url }))],
    'POST /api/v2/user/webhooks': (request) => {
      webhookList = new URLSearchParams(request.body).getAll('urls[]');
      return [201, ''];
    },
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
  assert.deepEqual(await plexTv.homeUsers('token-1'), [
    { id: '1', name: 'Steve', admin: true, managed: false },
    { id: '2', name: 'Kids & Co', admin: false, managed: true },
  ]);
  assert.deepEqual(await plexTv.webhooks('token-1'), ['https://example.com/hook']);
  await plexTv.setWebhooks('token-1', ['https://example.com/hook', 'http://10.0.0.5:32550/abc']);
  assert.deepEqual(await plexTv.webhooks('token-1'), ['https://example.com/hook', 'http://10.0.0.5:32550/abc']);
  assert.ok(requests.every((request) => request.headers['x-plex-client-identifier'] === 'client-1'));
  assert.ok(requests.every((request) => !request.url.includes('token-1')), 'tokens are sent as headers');
});

test('discovery merges servers, ranks players, lists Home users and groups libraries', async () => {
  const plexTv = {
    devices: async () => [
      { id: 'ATV', name: 'Living Room', platform: 'tvOS', lastSeenAt: 1_000 },
      { id: 'PHONE', name: 'iPhone', platform: 'iOS', lastSeenAt: 5_000 },
      { id: 'OLD', name: 'Old Roku', lastSeenAt: 9_000 },
    ],
    homeUsers: async () => [{ id: '1', name: 'Steve', admin: true, managed: false }, { id: '2', name: 'Kids', admin: false, managed: true }],
  };
  const main = {
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
    libraries: async () => [
      { id: '1', title: 'Movies', type: 'movie', agent: 'tv.plex.agents.movie' },
      { id: '2', title: 'Home Videos', type: 'movie', agent: 'tv.plex.agents.none' },
      { id: '3', title: 'TV Shows', type: 'show' },
      { id: '4', title: 'Music', type: 'artist' },
      { id: '5', title: 'Photos', type: 'photo' },
    ],
    hasLiveTv: async () => true,
  };
  const second = {
    devices: async () => [{ id: '7', clientIdentifier: 'ATV', name: 'Apple TV' }],
    history: async () => [{ deviceId: '7', accountId: '1', viewedAt: 400 }],
    sessions: async () => [],
    accounts: async () => [],
    libraries: async () => {
      throw new Error('Plex returned HTTP 401 for /library/sections');
    },
    hasLiveTv: async () => {
      throw new Error('offline');
    },
  };
  const result = await discover([{ id: 'a', name: 'Unraid', server: main }, { id: 'b', name: 'Cabin', server: second }], plexTv, 'token');
  assert.deepEqual(result.players.map((p) => p.id), ['BEDROOM', 'ATV', 'PHONE', 'OLD']);
  assert.equal(result.players[1].name, 'Living Room', 'the account name wins over the server one');
  assert.equal(result.players[1].plays, 3, 'plays add up across servers');
  assert.equal(result.players[0].playingNow, true);
  assert.deepEqual(result.users.map((u) => u.name), ['Steve', 'Kids']);
  assert.deepEqual(result.servers[0].libraries.map((l) => `${l.key}:${l.kind}`), ['a/1:movie', 'a/2:other', 'a/3:show', 'a/4:music', 'a/5:photo', 'a/livetv:livetv']);
  assert.deepEqual(result.servers[1].libraries, []);
  assert.match(result.servers[1].error, /401/);
});

test('library types: Other Videos never get credits, and a new library is read at once', async () => {
  const { LibraryTypes } = await import('../dist/plex/library-types.js');
  let libraries = [{ id: '1', title: 'Movies', type: 'movie', agent: 'tv.plex.agents.movie' }];
  let reads = 0;
  const types = new LibraryTypes([{ serverId: 'a', libraries: async () => { reads++; return libraries; } }]);
  await types.refresh();
  assert.equal(await types.hasCredits('a', { type: 'movie', librarySectionId: '1' }), true);
  assert.equal(await types.hasCredits('a', { type: 'track', librarySectionId: '1' }), false);
  libraries = [...libraries, { id: '7', title: 'Home Videos', type: 'movie', agent: 'tv.plex.agents.none' }, { id: '8', title: 'More Movies', type: 'movie' }];
  assert.equal(await types.hasCredits('a', { type: 'movie', librarySectionId: '7' }), false, 'new Other Videos library');
  assert.equal(reads, 2, 'read again because library 7 was new');
  assert.equal(await types.hasCredits('a', { type: 'movie', librarySectionId: '8' }), true, 'new movie library');
  assert.equal(reads, 2, 'already known from the same read');
  assert.equal(await types.hasCredits('a', { type: 'episode', librarySectionId: 'livetv', live: true }), false, 'Live TV never has credits');
  assert.equal(reads, 2, 'Live TV is not an unknown library');
});

test('Live TV sessions become the server\'s Live TV library', async () => {
  const { sessionFromMetadata } = await import('../dist/plex/convert.js');
  const live = sessionFromMetadata({ ratingKey: '99', type: 'episode', title: 'News', live: '1', Player: { machineIdentifier: 'ATV' } });
  assert.equal(live.media.live, true);
  assert.equal(live.media.librarySectionId, 'livetv');
  assert.equal(live.media.librarySectionTitle, 'Live TV');
  const normal = sessionFromMetadata({ ratingKey: '5', type: 'movie', librarySectionID: 1, Player: { machineIdentifier: 'ATV' } });
  assert.equal(normal.media.live, undefined);
  assert.equal(normal.media.librarySectionId, '1');
});

test('media facts come from the library item and the show', async () => {
  const { factsFromMetadata } = await import('../dist/plex/media-facts.js');
  const facts = factsFromMetadata({
    type: 'movie', contentRating: 'PG-13', Label: [{ tag: 'Date Night' }],
    Media: [{ aspectRatio: '2.35', videoResolution: '4k', Part: [{ Stream: [{ streamType: 2 }, { streamType: 1, DOVIPresent: '1', colorTrc: 'smpte2084' }] }] }],
  });
  assert.deepEqual(facts, { aspectRatio: 2.35, resolution: '4k', dynamicRange: 'dv', contentRating: 'PG-13', labels: ['Date Night'] });
  const episode = factsFromMetadata({ type: 'episode', Media: [{ aspectRatio: 1.78, videoResolution: '1080', Part: [{ Stream: [{ streamType: 1, colorTrc: 'bt709' }] }] }] },
    { contentRating: 'TV-Y7', Label: [{ tag: 'Kids' }] });
  assert.deepEqual(episode, { aspectRatio: 1.78, resolution: 'hd', dynamicRange: 'sdr', contentRating: 'TV-Y7', labels: ['Kids'] });
  assert.equal(factsFromMetadata({ Media: [{ Part: [{ Stream: [{ streamType: 1, colorTrc: 'arib-std-b67' }] }] }] }).dynamicRange, 'hdr', 'HLG');
});

test('the running record tells whether saved settings are in use', async () => {
  const { configFingerprint } = await import('../dist/runtime.js');
  const a = configFingerprint({ platform: 'PlexIntermission', sensors: [{ id: 's', name: 'A' }], timing: { stopHold: 5 } });
  assert.equal(a, configFingerprint({ timing: { stopHold: 5 }, sensors: [{ name: 'A', id: 's' }], platform: 'PlexIntermission', _bridge: { port: 1 } }), 'key order and Homebridge keys do not matter');
  assert.notEqual(a, configFingerprint({ platform: 'PlexIntermission', sensors: [{ id: 's', name: 'B' }], timing: { stopHold: 5 } }));
});
