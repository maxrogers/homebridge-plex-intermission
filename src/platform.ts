import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';

import { EventEmitter } from 'node:events';

import { parseConfig, type IntermissionConfig } from './config.js';
import { Controller, type SensorOutput } from './controller.js';
import { systemClock } from './engine/clock.js';
import type { Logger } from './engine/types.js';
import { CREDITED_TYPES } from './engine/credits.js';
import { libraryKind } from './plex/discovery.js';
import { MarkerCache } from './plex/marker-cache.js';
import { NotificationStream } from './plex/notifications.js';
import { PlexTv } from './plex/plex-tv.js';
import { PlexHttpError, PlexServer } from './plex/server.js';
import { WebhookServer } from './plex/webhook-server.js';
import { SensorAccessory } from './sensors/sensor-accessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { serverToken, Storage } from './storage.js';

/**
 * Several servers can drive the same sensor. A state sensor is on while any server says so;
 * presses pass straight through.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

class SensorHub {
  /** Servers voting "on", or for "Nothing playing", servers voting "off" (busy). */
  private readonly votes = new Set<number>();
  private readonly allMustAgree: boolean;

  constructor(readonly accessory: SensorAccessory) {
    this.allMustAgree = accessory.config.state === 'idle';
  }

  output(voter: number): SensorOutput {
    return {
      config: this.accessory.config,
      setActive: (active) => {
        if (active !== this.allMustAgree) {
          this.votes.add(voter);
        } else {
          this.votes.delete(voter);
        }
        this.accessory.setActive(this.allMustAgree ? this.votes.size === 0 : this.votes.size > 0);
      },
      press: () => this.accessory.press(),
    };
  }
}

export class IntermissionPlatform implements DynamicPlatformPlugin {
  private readonly accessories = new Map<string, PlatformAccessory>();
  private readonly log: Logger;
  private readonly settings: IntermissionConfig;
  private readonly controllers: Controller[] = [];
  private webhooks?: WebhookServer;
  private dailyTimer?: NodeJS.Timeout;

  constructor(
    private readonly logging: Logging,
    config: PlatformConfig,
    private readonly api: API,
  ) {
    this.log = this.createLogger();
    this.settings = parseConfig(config, this.log);
    this.api.on('didFinishLaunching', () => {
      this.start().catch((error: unknown) => this.log.error('Could not start: %s', error instanceof Error ? error.message : String(error)));
    });
    this.api.on('shutdown', () => {
      clearInterval(this.dailyTimer);
      for (const controller of this.controllers) {
        void controller.stop();
      }
      void this.webhooks?.stop();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.set(accessory.UUID, accessory);
  }

  private async start(): Promise<void> {
    // Sensors exist even before sign-in, so Home automations that use them keep working.
    const hubs = this.syncAccessories().map((accessory) => new SensorHub(accessory));

    const storage = new Storage(this.api.user.storagePath());
    const credentials = await storage.readCredentials();
    const servers = this.settings.servers;
    if (!credentials?.setupId || servers.length === 0 || credentials.setupId !== this.settings.setupId) {
      this.log.info('Not signed in to Plex yet. Open the plugin settings to set up %s.', this.settings.name);
      return;
    }

    const state = await storage.state();
    const plexTv = new PlexTv({ clientIdentifier: state.clientIdentifier });
    const plexPass = await this.checkPlexPass(plexTv, credentials.accountToken);
    if (plexPass === 'unauthorized') {
      return;
    }
    if (plexPass === false) {
      this.log.info('No Plex Pass: play is noticed at the first progress report, new media gets no credits markers, and webhook-only events are unavailable.');
    }
    if (plexPass !== undefined) {
      await storage.recordPlexPass(plexPass);
    }

    const feed = new EventEmitter<{ payload: [unknown] }>();
    if (this.settings.webhook.enabled && plexPass !== false) {
      await this.startWebhooks(state.webhookSecret, feed);
    }

    // "Other Videos" libraries hold movies to Plex, but they have no credits.
    const personal = new Set<string>();
    const hasCredits = (serverId: string) => (media: { type: string; librarySectionId?: string }) =>
      CREDITED_TYPES.has(media.type) && !personal.has(`${serverId}/${media.librarySectionId}`);

    const plexServers = servers.map((server) => new PlexServer({ baseUrl: server.url, token: serverToken(credentials, server.id), clientIdentifier: state.clientIdentifier }));
    const readLibraries = async () => {
      await Promise.all(servers.map(async (server, index) => {
        const libraries = await plexServers[index]!.libraries().catch(() => undefined);
        for (const library of libraries ?? []) {
          const key = `${server.id}/${library.id}`;
          if (libraryKind(library) === 'other') {
            personal.add(key);
          } else {
            personal.delete(key);
          }
        }
      }));
    };
    await readLibraries();

    servers.forEach((server, index) => {
      const plex = plexServers[index]!;
      const markers = new MarkerCache((ratingKey) => plex.markers(ratingKey), systemClock);
      const controller = new Controller({
        config: this.settings,
        server,
        log: servers.length > 1 ? prefixed(this.log, server.name) : this.log,
        clock: systemClock,
        plex,
        stream: new NotificationStream({ url: plex.notificationsUrl(), log: this.log }),
        webhooks: feed,
        getMarkers: (ratingKey) => markers.get(ratingKey),
        hasCredits: hasCredits(server.id),
        sensors: hubs.map((hub) => hub.output(index)),
      });
      this.controllers.push(controller);
      void controller.start();
    });
    this.log.info('Watching %s with %d sensor%s.', servers.map((s) => s.name).join(' and '), hubs.length, hubs.length === 1 ? '' : 's');

    // Once a day: Plex Pass status and the library list.
    this.dailyTimer = setInterval(() => {
      void readLibraries();
      void this.dailyPlexPassCheck(plexTv, credentials.accountToken, storage, state.webhookSecret, feed);
    }, DAY_MS);
    this.dailyTimer.unref();
  }

  /** Notices Plex Pass ending or starting, adjusts webhooks, and leaves a notice for the settings page. */
  private async dailyPlexPassCheck(plexTv: PlexTv, token: string, storage: Storage, secret: string, feed: EventEmitter<{ payload: [unknown] }>): Promise<void> {
    const active = await this.checkPlexPass(plexTv, token);
    if (active === undefined || active === 'unauthorized') {
      return;
    }
    const before = await storage.readPlexPass();
    await storage.recordPlexPass(active);
    if (before?.active === active) {
      return;
    }
    if (active) {
      this.log.info('Plex Pass detected. Open the plugin settings to add the Intermission webhook for instant play detection and more events.');
      if (this.settings.webhook.enabled && !this.webhooks) {
        await this.startWebhooks(secret, feed);
      }
    } else {
      this.log.warn('Plex Pass ended. Intermission keeps working: play is noticed at the first progress report, new media gets no credits markers (95% of the runtime is used), and webhook-only events stop.');
    }
  }

  private async startWebhooks(secret: string, feed: EventEmitter<{ payload: [unknown] }>): Promise<void> {
    const webhooks = new WebhookServer({ port: this.settings.webhook.port, secret, log: this.log });
    webhooks.on('payload', (payload) => feed.emit('payload', payload));
    try {
      await webhooks.start();
      this.webhooks = webhooks;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      this.log.error(code === 'EADDRINUSE'
        ? 'Cannot receive Plex webhooks: port %d is in use. Choose another port in the plugin settings.'
        : 'Cannot receive Plex webhooks on port %d: %s', this.settings.webhook.port, (error as Error).message);
    }
  }

  /** Returns Plex Pass status, or undefined when plex.tv cannot be reached (assume the best). */
  private async checkPlexPass(plexTv: PlexTv, token: string): Promise<boolean | undefined | 'unauthorized'> {
    try {
      return (await plexTv.user(token)).plexPass;
    } catch (error) {
      if (error instanceof PlexHttpError && error.status === 401) {
        this.log.error('Plex no longer accepts the saved sign-in. Open the plugin settings and sign in again.');
        return 'unauthorized';
      }
      this.log.warn('Cannot reach plex.tv to check Plex Pass: %s', error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }

  /** Creates, updates and removes accessories to match the configured sensors. */
  private syncAccessories(): SensorAccessory[] {
    const wanted = new Set<string>();
    const created: PlatformAccessory[] = [];
    const renamed: PlatformAccessory[] = [];
    const sensors = this.settings.sensors.map((sensor) => {
      const uuid = this.api.hap.uuid.generate(`intermission:${sensor.id}`);
      wanted.add(uuid);
      let accessory = this.accessories.get(uuid);
      if (!accessory) {
        accessory = new this.api.platformAccessory(sensor.name, uuid);
        this.accessories.set(uuid, accessory);
        created.push(accessory);
      } else if (accessory.displayName !== sensor.name) {
        accessory.displayName = sensor.name;
        renamed.push(accessory);
      }
      accessory.context.sensorId = sensor.id;
      return new SensorAccessory(this.api, accessory, sensor);
    });

    const stale = [...this.accessories.values()].filter((accessory) => !wanted.has(accessory.UUID));
    for (const accessory of stale) {
      this.accessories.delete(accessory.UUID);
    }
    if (created.length > 0) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, created);
    }
    if (renamed.length > 0) {
      this.api.updatePlatformAccessories(renamed);
    }
    if (stale.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      this.log.info('Removed %d sensor%s no longer in the settings.', stale.length, stale.length === 1 ? '' : 's');
    }
    return sensors;
  }

  /** Detailed logging shows debug messages at info level, without needing Homebridge debug mode. */
  private createLogger(): Logger {
    const logging = this.logging;
    // Read at call time: parseConfig logs through this logger before the settings exist.
    const detailed = () => this.settings?.detailedLogging === true;
    return {
      debug: (message, ...parameters) => (detailed() ? logging.info(message, ...parameters) : logging.debug(message, ...parameters)),
      info: (message, ...parameters) => logging.info(message, ...parameters),
      warn: (message, ...parameters) => logging.warn(message, ...parameters),
      error: (message, ...parameters) => logging.error(message, ...parameters),
    };
  }
}

function prefixed(log: Logger, name: string): Logger {
  return {
    debug: (message, ...parameters) => log.debug(`${name}: ${message}`, ...parameters),
    info: (message, ...parameters) => log.info(`${name}: ${message}`, ...parameters),
    warn: (message, ...parameters) => log.warn(`${name}: ${message}`, ...parameters),
    error: (message, ...parameters) => log.error(`${name}: ${message}`, ...parameters),
  };
}
