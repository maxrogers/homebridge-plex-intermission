// Requests from the settings page. Runs in the Homebridge UI's plugin server, not in Homebridge itself.
import { networkInterfaces } from 'node:os';

import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';
import qrcode from 'qrcode-generator';

import { CommandRunner } from '../dist/commands.js';
import { PlexHttpError } from '../dist/plex/server.js';
import { diagnosticsReport, liveLog } from '../dist/report.js';
import { SetupError, SetupService, webhookOptionsFrom } from '../dist/setup-service.js';
import { Storage } from '../dist/storage.js';

/** Sample values for testing a command from Settings. */
const SAMPLE_CONTEXT = { sensor: 'Media Playing', state: 'on', title: 'Test Movie', type: 'movie', library: 'Movies', player: 'Living Room', user: 'Test User' };
const QUIET = { debug() {}, info() {}, warn() {}, error() {} };

class IntermissionUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    const service = new SetupService({ storage: new Storage(this.homebridgeStoragePath), networkInterfaces });
    const webhook = (body) => ({ ...webhookOptionsFrom(body.config ?? {}), servers: body.servers ?? [] });
    const list = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);

    this.handle('/status', (body) => service.status(typeof body.setupId === 'string' ? body.setupId : undefined));
    this.handle('/about', () => service.about());
    this.handle('/runtime', (body) => service.runtime(body.config ?? {}));
    this.handle('/plexpass/ack', () => service.acknowledgePlexPass());
    this.handle('/bridge/pairing', async (body) => {
      const pairing = await service.bridgePairing(String(body.username ?? ''));
      if (!pairing.setupURI || pairing.paired) {
        return pairing;
      }
      const qr = qrcode(0, 'M');
      qr.addData(pairing.setupURI);
      qr.make();
      return { ...pairing, qrSvg: qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }) };
    });

    this.handle('/signin/start', (body) => service.startSignIn(body.mode === 'code' ? 'code' : 'browser'));
    this.handle('/signin/check', () => service.checkSignIn());
    this.handle('/signout', () => service.signOut());
    this.handle('/reset', (body) => service.resetPlugin(webhook(body)));

    this.handle('/servers', () => service.servers());
    this.handle('/servers/select', (body) => service.selectServers(list(body.ids)));
    this.handle('/discover', (body) => service.discover(body.servers ?? []));
    this.handle('/nowplaying', (body) => service.nowPlaying(body.servers ?? []));

    this.handle('/webhook/status', (body) => service.webhookStatus(webhook(body)));
    this.handle('/webhook/update', (body) => service.updateWebhooks(webhook(body), { add: body.add === true, remove: list(body.remove) }));
    this.handle('/webhook/remove', (body) => service.removeWebhook(webhook(body)));

    this.handle('/commands/test', (body) => new CommandRunner(QUIET, 15_000).run(
      { id: 'test', name: String(body.name ?? 'Test'), command: String(body.command ?? '') },
      SAMPLE_CONTEXT,
    ));
    this.handle('/diagnostics', (body) => diagnosticsReport(service, {
      config: body.config ?? {},
      servers: body.servers ?? [],
      homebridgeVersion: body.homebridgeVersion,
      nodeVersion: process.version,
      timeZone: typeof body.timeZone === 'string' ? body.timeZone.slice(0, 80) : undefined,
      includeNames: body.includeNames === true,
    }, new Date()));
    this.handle('/diagnostics/live', () => liveLog(service));
    this.ready();
  }

  /** Registers a handler whose failures reach the page as a readable message, never with a token. */
  handle(path, handler) {
    this.onRequest(path, async (body) => {
      try {
        return await handler(body ?? {});
      } catch (error) {
        if (error instanceof SetupError) {
          throw new RequestError(error.message, { status: error.status });
        }
        if (error instanceof PlexHttpError && error.status === 401) {
          throw new RequestError('Plex did not accept the sign-in. Please sign in again.', { status: 401 });
        }
        throw new RequestError(error instanceof Error ? error.message : String(error), { status: 500 });
      }
    });
  }
}

new IntermissionUiServer();
