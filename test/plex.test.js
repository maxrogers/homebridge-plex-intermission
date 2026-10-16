import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { markersFromMetadata, parseNotification, webhookFromPayload } from '../dist/plex/convert.js';
import { MarkerCache } from '../dist/plex/marker-cache.js';
import { extractWebhookPayload } from '../dist/plex/multipart.js';
import { NotificationStream } from '../dist/plex/notifications.js';
import { PlexHttpError, PlexServer } from '../dist/plex/server.js';
import { WebhookServer } from '../dist/plex/webhook-server.js';
import { FakeClock, silentLog } from './helpers.js';

const payload = {
  event: 'media.pause',
  owner: true,
  Account: { title: 'owner' },
  Server: { uuid: 'server-1' },
  Player: { title: 'Apple TV', uuid: 'APPLE-TV', local: true },
  Metadata: { ratingKey: '42', type: 'movie', title: 'Movie', duration: 7_200_000, viewOffset: 61_000, librarySectionID: 1, librarySectionTitle: 'Movies' },
};

function multipart(json, boundary = 'xyz') {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="payload"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(json)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="thumb"; filename="t.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    Buffer.from([0xff, 0xd8, 0x00, 0x2d, 0x2d]),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

test('extracts the webhook payload from multipart and plain JSON bodies', () => {
  assert.deepEqual(extractWebhookPayload(multipart(payload), 'multipart/form-data; boundary=xyz'), payload);
  assert.deepEqual(extractWebhookPayload(multipart(payload, 'a b'), 'multipart/form-data; boundary="a b"'), payload);
  assert.deepEqual(extractWebhookPayload(Buffer.from(JSON.stringify(payload)), 'application/json'), payload);
  assert.equal(extractWebhookPayload(Buffer.from('not json'), 'text/plain'), undefined);
});

test('converts a webhook payload', () => {
  assert.deepEqual(webhookFromPayload(payload), {
    event: 'media.pause',
    owner: true,
    user: 'owner',
    serverId: 'server-1',
    viewOffset: 61_000,
    media: { ratingKey: '42', title: 'Movie', type: 'movie', durationMs: 7_200_000, librarySectionId: '1', librarySectionTitle: 'Movies' },
    session: {
      playerId: 'APPLE-TV',
      playerTitle: 'Apple TV',
      product: undefined,
      platform: undefined,
      user: 'owner',
      local: true,
      media: { ratingKey: '42', title: 'Movie', type: 'movie', durationMs: 7_200_000, librarySectionId: '1', librarySectionTitle: 'Movies' },
    },
  });
  assert.equal(webhookFromPayload({ event: 'library.new' }).session, undefined);
  assert.equal(webhookFromPayload({}), undefined);
});

test('parses playback notifications and skips malformed entries', () => {
  const message = JSON.stringify({
    NotificationContainer: {
      type: 'playing',
      PlaySessionStateNotification: [
        { sessionKey: '7', clientIdentifier: 'APPLE-TV', ratingKey: '42', state: 'buffering', viewOffset: 120_000, guid: 'x' },
        { sessionKey: '8', clientIdentifier: 'OTHER', ratingKey: '43', state: 'rewinding', viewOffset: 1 },
        { sessionKey: '9', ratingKey: '44', state: 'playing', viewOffset: 1 },
      ],
    },
  });
  assert.deepEqual(parseNotification(message), {
    type: 'playing',
    playing: [{ sessionKey: '7', clientIdentifier: 'APPLE-TV', ratingKey: '42', state: 'buffering', viewOffset: 120_000 }],
  });
  assert.deepEqual(parseNotification('{"NotificationContainer":{"type":"activity"}}'), { type: 'activity', playing: [] });
  assert.equal(parseNotification('nonsense'), undefined);
});

test('reads markers, ignoring incomplete ones', () => {
  const markers = markersFromMetadata([{ Marker: [
    { type: 'intro', startTimeOffset: 1_000, endTimeOffset: 60_000 },
    { type: 'credits', startTimeOffset: '8136585', endTimeOffset: 8_700_650, final: '1' },
    { type: 'credits' },
  ] }]);
  assert.deepEqual(markers, [
    { type: 'intro', startMs: 1_000, endMs: 60_000, final: false },
    { type: 'credits', startMs: 8_136_585, endMs: 8_700_650, final: true },
  ]);
});

test('webhook server accepts only POSTs to its secret path', async () => {
  const server = new WebhookServer({ port: 0, host: '127.0.0.1', secret: 's3cret', log: silentLog, maxBodyBytes: 4_096 });
  await server.start();
  const port = server.port;
  const received = [];
  server.on('payload', (body) => received.push(body));
  const post = (path, body, type = 'multipart/form-data; boundary=xyz') =>
    fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': type }, body });
  try {
    assert.equal((await post('/s3cret', multipart(payload))).status, 200);
    assert.equal((await post('/wrong', multipart(payload))).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/s3cret`)).status, 404);
    assert.equal((await post('/s3cret', Buffer.alloc(10_000, 'a'), 'text/plain').catch(() => ({ status: 413 }))).status, 413);
    assert.deepEqual(received, [payload]);
  } finally {
    await server.stop();
  }
});

test('webhook server reports a port that is already in use', async () => {
  const first = new WebhookServer({ port: 0, host: '127.0.0.1', secret: 'a', log: silentLog });
  await first.start();
  const port = first.port;
  const second = new WebhookServer({ port, host: '127.0.0.1', secret: 'b', log: silentLog });
  await assert.rejects(second.start(), { code: 'EADDRINUSE' });
  await first.stop();
  await second.stop();
});

test('marker cache reuses results and re-checks items without markers later', async () => {
  const clock = new FakeClock();
  let calls = 0;
  const cache = new MarkerCache(async (ratingKey) => {
    calls += 1;
    return ratingKey === 'with' ? [{ type: 'credits', startMs: 1, endMs: 2, final: true }] : [];
  }, clock, 1_000);
  await Promise.all([cache.get('with'), cache.get('with')]);
  await cache.get('with');
  assert.equal(calls, 1);
  await cache.get('without');
  await cache.get('without');
  assert.equal(calls, 2);
  await clock.advance(1_001);
  await cache.get('without');
  assert.equal(calls, 3);
});

test('server client sends the token as a header and maps sessions and markers', async () => {
  const seen = [];
  const plex = createServer((request, response) => {
    seen.push({ url: request.url, token: request.headers['x-plex-token'] });
    const json = (body) => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (request.url === '/status/sessions') {
      return json({ MediaContainer: { Metadata: [
        { ratingKey: '42', sessionKey: '7', type: 'movie', title: 'Movie', duration: 7_200_000,
          Player: { machineIdentifier: 'APPLE-TV', title: 'Apple TV', product: 'Plex for Apple TV', platform: 'tvOS', local: true },
          User: { title: 'owner' } },
      ] } });
    }
    if (request.url === '/library/metadata/42?includeMarkers=1') {
      return json({ MediaContainer: { Metadata: [{ Marker: [{ type: 'credits', startTimeOffset: 100, endTimeOffset: 200, final: true }] }] } });
    }
    response.writeHead(401).end();
  });
  await new Promise((resolve) => plex.listen(0, '127.0.0.1', resolve));
  const { port } = plex.address();
  const server = new PlexServer({ baseUrl: `http://127.0.0.1:${port}/`, token: 'tok', clientIdentifier: 'test' });
  try {
    const session = await server.session('APPLE-TV', '7');
    assert.equal(session.playerTitle, 'Apple TV');
    assert.equal(session.media.durationMs, 7_200_000);
    assert.deepEqual(await server.markers('42'), [{ type: 'credits', startMs: 100, endMs: 200, final: true }]);
    await assert.rejects(server.markers('nope'), (error) => error instanceof PlexHttpError && error.status === 401 && !error.message.includes('tok'));
    assert.ok(seen.every((request) => request.token === 'tok' && !request.url.includes('tok')));
    assert.equal(server.notificationsUrl(), `ws://127.0.0.1:${port}/:/websockets/notifications?X-Plex-Token=tok`);
  } finally {
    plex.close();
  }
});

test('notification stream stops cleanly while it cannot connect', async () => {
  const stream = new NotificationStream({ url: 'ws://127.0.0.1:9/', log: silentLog, minBackoffMs: 10, maxBackoffMs: 20 });
  stream.start();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(stream.isConnected, false);
  stream.stop();
});
