import { networkInterfaces } from 'node:os';

import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';

import { PlexHttpError } from '../dist/plex/server.js';
import { SetupError, SetupService, webhookOptionsFrom } from '../dist/setup-service.js';
import { Storage } from '../dist/storage.js';

class IntermissionUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    const service = new SetupService({ storage: new Storage(this.homebridgeStoragePath), networkInterfaces });
    const webhook = (body) => ({ ...webhookOptionsFrom(body.config ?? {}), servers: body.servers ?? [] });

    this.handle('/status', (body) => service.status(typeof body.setupId === 'string' ? body.setupId : undefined));
    this.handle('/about', () => service.about());
    this.handle('/plexpass/ack', () => service.acknowledgePlexPass());
    this.handle('/reset', (body) => service.resetPlugin(webhook(body)));
    this.handle('/signin/start', (body) => service.startSignIn(body.mode === 'code' ? 'code' : 'browser'));
    this.handle('/signin/check', () => service.checkSignIn());
    this.handle('/signout', () => service.signOut());
    this.handle('/servers', () => service.servers());
    this.handle('/servers/select', (body) => service.selectServers(Array.isArray(body.ids) ? body.ids : []));
    this.handle('/discover', (body) => service.discover(body.servers ?? []));
    this.handle('/webhook/status', (body) => service.webhookStatus(webhook(body)));
    this.handle('/webhook/add', (body) => service.addWebhook(webhook(body)));
    this.handle('/webhook/update', (body) => service.updateWebhooks(webhook(body), {
      add: body.add === true,
      remove: Array.isArray(body.remove) ? body.remove.filter((url) => typeof url === 'string') : [],
    }));
    this.handle('/webhook/remove', (body) => service.removeWebhook(webhook(body)));
    this.handle('/report', (body) => service.report({
      config: body.config ?? {},
      servers: body.servers ?? [],
      homebridgeVersion: body.homebridgeVersion,
      nodeVersion: process.version,
    }));
    this.ready();
  }

  /** Wraps a handler so failures reach the page as a readable message, never with a token. */
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
