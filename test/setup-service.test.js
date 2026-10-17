import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { lanAddress, serverAddress, SetupService } from '../dist/setup-service.js';
import { Storage } from '../dist/storage.js';

const nic = (address, netmask = '255.255.255.0', internal = false) => ({ address, netmask, family: 'IPv4', internal, mac: '', cidr: null });

test('picks the Homebridge address on the same network as the server', () => {
  const interfaces = {
    lo: [nic('127.0.0.1', '255.0.0.0', true)],
    docker0: [nic('172.17.0.1', '255.255.0.0')],
    virbr0: [nic('192.168.122.1')],
    br0: [nic('10.0.0.5')],
    eth1: [nic('192.168.50.2')],
  };
  assert.equal(lanAddress(interfaces, ['https://192-168-50-9.abc123.plex.direct:32400']), '192.168.50.2');
  assert.equal(lanAddress(interfaces, ['http://10.0.0.2:32400']), '10.0.0.5');
  assert.equal(lanAddress(interfaces, ['https://plex.example.com']), '10.0.0.5', 'first ordinary interface otherwise');
  assert.equal(serverAddress('https://10-0-0-2.0123abcd.plex.direct:32400'), '10.0.0.2');
  assert.equal(serverAddress('http://plex.local:32400'), undefined);
});

async function fakePlex(t, { plexPass = true, webhooks = [], webhooksEnabled = false } = {}) {
  const state = { webhooks: [...webhooks], webhooksEnabled, posts: 0 };
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) {
      body += chunk;
    }
    const path = request.url.split('?')[0];
    const json = (value, status = 200) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    if (path === '/api/v2/user') {
      return json({ id: 1, username: 'steve', title: 'Steve', subscription: { active: plexPass } });
    }
    if (path === '/api/v2/user/webhooks' && request.method === 'GET') {
      return json(state.webhooks.map((url) => ({ url })));
    }
    if (path === '/api/v2/user/webhooks' && request.method === 'POST') {
      state.posts++;
      state.webhooks = new URLSearchParams(body).getAll('urls[]');
      return response.writeHead(201).end();
    }
    if (path === '/:/prefs' && request.method === 'GET') {
      return json({ MediaContainer: { Setting: [{ id: 'WebHooksEnabled', value: state.webhooksEnabled }, { id: 'GenerateCreditsMarkerBehavior', value: '2' }] } });
    }
    if (path === '/:/prefs' && request.method === 'PUT') {
      state.webhooksEnabled = new URL(request.url, 'http://x').searchParams.get('WebHooksEnabled') === '1';
      return response.writeHead(200).end();
    }
    if (path === '/identity') {
      return json({ MediaContainer: { machineIdentifier: 'srv', version: '1.41.0' } });
    }
    if (path === '/library/sections') {
      return json({ MediaContainer: { Directory: [{ key: '1', title: 'Movies', type: 'movie', agent: 'tv.plex.agents.movie' }] } });
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const directory = await mkdtemp(join(tmpdir(), 'intermission-setup-'));
  t.after(async () => {
    server.close();
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const storage = new Storage(directory);
  await storage.writeCredentials({ accountToken: 'account-token', username: 'Steve', savedAt: 'now', setupId: 'setup-1' });
  const service = new SetupService({
    storage,
    plexTvBaseUrl: base,
    networkInterfaces: () => ({ br0: [nic('10.0.0.5')] }),
  });
  const { webhookSecret } = await storage.state();
  return { service, storage, state, servers: [{ id: 'srv', name: 'Unraid', url: base }], secret: webhookSecret };
}

test('adds the webhook, keeps the others, replaces an old address and turns the server setting on', async (t) => {
  const { service, state, servers, secret } = await fakePlex(t, { webhooks: ['https://other.example/hook'] });
  state.webhooks.push(`http://10.0.0.99:32550/${secret}`);

  const before = await service.webhookStatus({ servers });
  assert.equal(before.registered, false);
  assert.equal(before.url, `http://10.0.0.5:32550/${secret}`);
  assert.deepEqual(before.others, ['https://other.example/hook']);
  assert.equal(before.stale.length, 1);
  assert.deepEqual(before.disabledOn, ['Unraid']);

  const after = await service.addWebhook({ servers });
  assert.equal(after.registered, true);
  assert.deepEqual(state.webhooks, ['https://other.example/hook', `http://10.0.0.5:32550/${secret}`]);
  assert.equal(state.webhooksEnabled, true);
  assert.deepEqual(after.disabledOn, []);

  await service.addWebhook({ servers });
  assert.equal(state.posts, 1, 'nothing to change the second time');

  const removed = await service.removeWebhook({ servers });
  assert.equal(removed.registered, false);
  assert.deepEqual(state.webhooks, ['https://other.example/hook']);
});

test('without Plex Pass the webhook is not offered', async (t) => {
  const { service, servers } = await fakePlex(t, { plexPass: false });
  const status = await service.webhookStatus({ servers });
  assert.equal(status.plexPass, false);
  await assert.rejects(service.addWebhook({ servers }), /Plex Pass/);
});

test('the report summarises without secrets', async (t) => {
  const { service, servers, secret } = await fakePlex(t, { webhooksEnabled: true });
  const report = await service.report({
    config: { setupId: 'setup-1', sensors: [{ name: 'Media Playing', type: 'occupancy', state: 'playing' }], timing: { stopHold: 20 } },
    servers,
    homebridgeVersion: '2.4.0',
    nodeVersion: 'v24.0.0',
  });
  assert.match(report, /Plex Pass: yes/);
  assert.match(report, /Version: 1\.41\.0/);
  assert.match(report, /Credits detection: as a scheduled task and when media is added/);
  assert.match(report, /Library 1: Movies \(movie/);
  assert.match(report, /Media Playing: occupancy playing/);
  assert.match(report, /Server: Unraid \(http:\/\/127\.0\.0\.1:/);
  assert.doesNotMatch(report, /account-token/);
  assert.doesNotMatch(report, new RegExp(secret));
});

test('removes chosen webhooks and keeps the rest', async (t) => {
  const { service, state, servers } = await fakePlex(t, { webhooks: ['https://old.example/a', 'https://keep.example/b'] });
  const status = await service.updateWebhooks({ servers }, { add: true, remove: ['https://old.example/a'] });
  assert.equal(status.registered, true);
  assert.deepEqual(state.webhooks.slice(0, 1), ['https://keep.example/b']);
  assert.equal(state.webhooks.length, 2);
});

test('reports who is on the webhook port', async (t) => {
  const { service, servers, secret } = await fakePlex(t);
  const { WebhookServer } = await import('../dist/plex/webhook-server.js');
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const unused = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const free = await service.webhookStatus({ servers, port: unused });
  assert.equal(free.portState, 'free');
  const ours = new WebhookServer({ port: 0, host: '127.0.0.1', secret, log: { debug() {}, info() {}, warn() {}, error() {} } });
  await ours.start();
  t.after(() => ours.stop());
  assert.equal((await service.webhookStatus({ servers, port: ours.port })).portState, 'intermission');
  const other = createServer((request, response) => response.writeHead(404).end());
  await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
  t.after(() => other.close());
  assert.equal((await service.webhookStatus({ servers, port: other.address().port })).portState, 'other');
});

test('a sign-in left from a removed install is erased', async (t) => {
  const { service, storage } = await fakePlex(t);
  assert.equal((await service.status('setup-1')).signedIn, true);
  assert.equal((await service.status(undefined)).signedIn, false, 'config without a setup id');
  assert.equal(await storage.readCredentials(), undefined);
});

test('a Plex Pass change is noticed once and kept until acknowledged', async (t) => {
  const { service, storage } = await fakePlex(t);
  assert.equal((await service.status('setup-1')).plexPassChange, undefined, 'first sight is silent');
  await storage.recordPlexPass(false, new Date('2026-10-30T12:00:00Z')); // the daily check saw it end
  await storage.recordPlexPass(true, new Date('2026-11-02T12:00:00Z'));
  let status = await service.status('setup-1');
  assert.equal(status.plexPassChange.active, true);
  status = await service.status('setup-1');
  assert.ok(status.plexPassChange, 'still shown until dismissed');
  await service.acknowledgePlexPass();
  assert.equal((await service.status('setup-1')).plexPassChange, undefined);
});

test('reset removes the webhook, the sign-in and the Plex Pass history', async (t) => {
  const { service, storage, state, servers, secret } = await fakePlex(t, { webhooks: ['https://other.example/hook'] });
  await service.addWebhook({ servers });
  assert.ok(state.webhooks.some((url) => url.endsWith(secret)));
  const result = await service.resetPlugin({ servers });
  assert.equal(result.webhookRemoved, true);
  assert.deepEqual(state.webhooks, ['https://other.example/hook']);
  assert.equal(await storage.readCredentials(), undefined);
  assert.equal(await storage.readPlexPass(), undefined);
});
