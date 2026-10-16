import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';

import { DEFAULT_FALLBACK_PERCENT_WITHOUT_PLEX_PASS, parseConfig, type IntermissionConfig } from './config.js';
import { Controller } from './controller.js';
import { systemClock } from './engine/clock.js';
import type { Logger } from './engine/types.js';
import { MarkerCache } from './plex/marker-cache.js';
import { NotificationStream } from './plex/notifications.js';
import { PlexTv } from './plex/plex-tv.js';
import { PlexHttpError, PlexServer } from './plex/server.js';
import { WebhookServer } from './plex/webhook-server.js';
import { SensorAccessory } from './sensors/sensor-accessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { Storage } from './storage.js';

export class IntermissionPlatform implements DynamicPlatformPlugin {
  private readonly accessories = new Map<string, PlatformAccessory>();
  private readonly log: Logger;
  private readonly settings: IntermissionConfig;
  private controller?: Controller;

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
      void this.controller?.stop();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.set(accessory.UUID, accessory);
  }

  private async start(): Promise<void> {
    // Sensors exist even before sign-in, so Home automations that use them keep working.
    const sensors = this.syncAccessories();

    const storage = new Storage(this.api.user.storagePath());
    const credentials = await storage.readCredentials();
    const server = this.settings.server;
    if (!credentials || !server) {
      this.log.info('Not signed in to Plex yet. Open the plugin settings to set up %s.', this.settings.name);
      return;
    }

    const state = await storage.state();
    const plexTv = new PlexTv({ clientIdentifier: state.clientIdentifier });
    const plexPass = await this.checkPlexPass(plexTv, credentials.accountToken);
    if (plexPass === 'unauthorized') {
      return;
    }

    const engine = { ...this.settings.engine };
    if (plexPass === false && !this.settings.fallbackConfigured) {
      engine.fallbackPercent = DEFAULT_FALLBACK_PERCENT_WITHOUT_PLEX_PASS;
    }
    if (plexPass === false) {
      this.log.info('No Plex Pass: credits use %s, and webhook-only events are unavailable.',
        engine.fallbackPercent === null ? 'markers already on the server only' : `${engine.fallbackPercent}% of the runtime when there is no marker`);
    }

    const plex = new PlexServer({
      baseUrl: server.url,
      token: credentials.serverToken ?? credentials.accountToken,
      clientIdentifier: state.clientIdentifier,
    });
    const markers = new MarkerCache((ratingKey) => plex.markers(ratingKey), systemClock);
    const webhooksWanted = this.settings.webhook.enabled && plexPass !== false;

    this.controller = new Controller({
      config: { ...this.settings, engine },
      log: this.log,
      clock: systemClock,
      server: plex,
      stream: new NotificationStream({ url: plex.notificationsUrl(), log: this.log }),
      webhooks: webhooksWanted
        ? new WebhookServer({ port: this.settings.webhook.port, secret: state.webhookSecret, log: this.log })
        : undefined,
      getMarkers: (ratingKey) => markers.get(ratingKey),
      sensors,
    });
    await this.controller.start();
    this.log.info('Watching %s with %d sensor%s.', server.name, sensors.length, sensors.length === 1 ? '' : 's');
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
