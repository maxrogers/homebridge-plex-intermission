import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';

import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CommandRunner } from './commands.js';
import { parseConfig, type IntermissionConfig } from './config.js';
import { Controller } from './controller.js';
import { DiagnosticLog } from './diagnostics.js';
import { guardedClock, systemClock, type Clock } from './engine/clock.js';
import type { Logger } from './engine/types.js';
import { describe } from './errors.js';
import { LibraryTypes } from './plex/library-types.js';
import { MarkerCache } from './plex/marker-cache.js';
import { NotificationStream } from './plex/notifications.js';
import { PlexTv } from './plex/plex-tv.js';
import { PlexHttpError, PlexServer } from './plex/server.js';
import { WebhookServer } from './plex/webhook-server.js';
import { maskAddress } from './network.js';
import { configFingerprint } from './runtime.js';
import { SensorAccessory } from './sensors/sensor-accessory.js';
import { CommandHooks, SensorHub } from './sensors/sensor-hub.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { serverToken, Storage } from './storage.js';

const DAY_MS = 24 * 60 * 60 * 1000;

type WebhookFeed = EventEmitter<{ payload: [unknown] }>;

export class IntermissionPlatform implements DynamicPlatformPlugin {
  private readonly accessories = new Map<string, PlatformAccessory>();
  private readonly log: Logger;
  private readonly clock: Clock;
  private readonly settings: IntermissionConfig;
  private readonly controllers: Controller[] = [];
  private readonly fingerprint: string;
  private readonly diagnostics: DiagnosticLog;
  private webhooks?: WebhookServer;
  private dailyTimer?: NodeJS.Timeout;

  constructor(
    private readonly logging: Logging,
    config: PlatformConfig,
    private readonly api: API,
  ) {
    this.diagnostics = new DiagnosticLog(join(this.api.user.storagePath(), 'intermission'));
    this.log = this.diagnostics.wrap(this.createLogger());
    this.clock = guardedClock(systemClock, (error) => {
      this.log.error('Unexpected error: %s', describe(error));
      this.log.debug('%s', error instanceof Error ? error.stack : String(error));
    });
    this.settings = parseConfig(config, this.log);
    this.fingerprint = configFingerprint(config);
    this.api.on('didFinishLaunching', () => {
      this.start().catch((error: unknown) => this.log.error('Could not start: %s', describe(error)));
    });
    this.api.on('shutdown', () => {
      clearInterval(this.dailyTimer);
      void this.diagnostics.flush();
      for (const controller of this.controllers) {
        controller.stop();
      }
      void this.webhooks?.stop();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.set(accessory.UUID, accessory);
  }

  private async start(): Promise<void> {
    // Sensors exist even before sign-in, so Home automations that use them keep working.
    const commands = new CommandHooks(this.settings.commands, new CommandRunner(this.log));
    const accessories = this.syncAccessories();
    const hubs = accessories.map((accessory) => new SensorHub(accessory, commands, this.log));
    for (const accessory of accessories) {
      const { config } = accessory;
      this.log.debug('Sensor %s: %s%s, restored %s.', config.name, config.type === 'button' ? `button for ${config.events.join(', ')}` : `${config.type} ${config.state}`,
        config.except.length ? ` except ${config.except.join(' and ')}` : '', config.type === 'button' ? '-' : accessory.isActive ? 'on' : 'off');
    }

    const storage = new Storage(this.api.user.storagePath());
    const version = await readFile(new URL('../package.json', import.meta.url), 'utf8')
      .then((text) => (JSON.parse(text) as { version?: string }).version ?? '?', () => '?');
    this.log.debug('Starting Intermission %s on Homebridge %s, Node.js %s, %d sensor%s.', version, this.api.serverVersion, process.version,
      this.settings.sensors.length, this.settings.sensors.length === 1 ? '' : 's');
    // Lets the settings page show whether the saved settings are running or need a restart.
    await storage.writeRunning({ fingerprint: this.fingerprint, startedAt: new Date().toISOString() })
      .catch((error: unknown) => this.log.debug('Could not record the running settings: %s', describe(error)));

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
    this.log.debug('Plex Pass: %s.', plexPass === undefined ? 'unknown (plex.tv unreachable)' : plexPass ? 'yes' : 'no');
    if (plexPass === false) {
      this.log.info('No Plex Pass: play is noticed at the first progress report, new media gets no credits markers, and webhook-only events are unavailable.');
    }
    if (plexPass !== undefined) {
      await storage.recordPlexPass(plexPass);
    }

    const feed: WebhookFeed = new EventEmitter();
    if (this.settings.webhook.enabled && plexPass !== false) {
      await this.startWebhooks(state.webhookSecret, feed);
    }

    for (const server of servers) {
      this.log.debug('Server %s at %s.', server.name, maskAddress(server.url));
    }
    this.log.debug('Settings: %s.', describeSettings(this.settings));
    const plexServers = servers.map((server) => new PlexServer({ baseUrl: server.url, token: serverToken(credentials, server.id), clientIdentifier: state.clientIdentifier }));
    const libraryTypes = new LibraryTypes(servers.map((server, index) => ({ serverId: server.id, libraries: () => plexServers[index]!.libraries() })));
    await libraryTypes.refresh();

    servers.forEach((server, index) => {
      const plex = plexServers[index]!;
      const markers = new MarkerCache((ratingKey) => plex.markers(ratingKey), this.clock);
      const controller = new Controller({
        config: this.settings,
        server,
        log: servers.length > 1 ? prefixed(this.log, server.name) : this.log,
        clock: this.clock,
        plex,
        stream: new NotificationStream({ url: plex.notificationsUrl(), log: this.log }),
        webhooks: feed,
        getMarkers: (ratingKey) => markers.get(ratingKey),
        hasCredits: (media) => libraryTypes.hasCredits(server.id, media),
        getFacts: (ratingKey) => plex.facts(ratingKey),
        sensors: hubs.map((hub) => hub.output(index)),
      });
      this.controllers.push(controller);
      controller.start();
    });
    this.log.info('Watching %s with %d sensor%s.', servers.map((s) => s.name).join(' and '), hubs.length, hubs.length === 1 ? '' : 's');

    // Once a day: Plex Pass status and the library list.
    this.dailyTimer = setInterval(() => {
      void libraryTypes.refresh();
      this.dailyPlexPassCheck(plexTv, credentials.accountToken, storage, state.webhookSecret, feed)
        .catch((error: unknown) => this.log.warn('Daily Plex Pass check failed: %s', describe(error)));
    }, DAY_MS);
    this.dailyTimer.unref();
  }

  /** Notices Plex Pass ending or starting, adjusts webhooks, and leaves a notice for the settings page. */
  private async dailyPlexPassCheck(plexTv: PlexTv, token: string, storage: Storage, secret: string, feed: WebhookFeed): Promise<void> {
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

  private async startWebhooks(secret: string, feed: WebhookFeed): Promise<void> {
    const webhooks = new WebhookServer({ port: this.settings.webhook.port, secret, log: this.log });
    webhooks.on('payload', (payload) => feed.emit('payload', payload));
    try {
      await webhooks.start();
      this.webhooks = webhooks;
      this.log.info('Listening for Plex webhooks on port %d.', this.settings.webhook.port);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      this.log.error(code === 'EADDRINUSE'
        ? 'Cannot receive Plex webhooks: port %d is in use. Choose another port in the plugin settings.'
        : 'Cannot receive Plex webhooks on port %d: %s', this.settings.webhook.port, describe(error));
    }
  }

  /** Plex Pass status, or undefined when plex.tv can't be reached (then nothing changes). */
  private async checkPlexPass(plexTv: PlexTv, token: string): Promise<boolean | undefined | 'unauthorized'> {
    try {
      return (await plexTv.user(token)).plexPass;
    } catch (error) {
      if (error instanceof PlexHttpError && error.status === 401) {
        this.log.error('Plex no longer accepts the saved sign-in. Open the plugin settings and sign in again.');
        return 'unauthorized';
      }
      this.log.warn('Cannot reach plex.tv to check Plex Pass: %s', describe(error));
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
        // updateDisplayName also renames the HAP accessory; assigning displayName does not.
        accessory.updateDisplayName(sensor.name);
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

  /** Detailed logging shows debug messages at info level, without Homebridge's debug mode. */
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

/** The settings that differ from the defaults, for the start-up log. */
function describeSettings(settings: IntermissionConfig): string {
  const engine = settings.engine;
  const parts = [
    `credits ${engine.creditsMode}`,
    engine.fallbackPercent === null ? 'no credits fallback' : `fallback ${engine.fallbackPercent}%`,
    `pause debounce ${engine.pauseDebounceMs / 1000}s`,
    `stop hold ${engine.stopHoldMs / 1000}s`,
    engine.creditsOffsetMs ? `credits offset ${engine.creditsOffsetMs / 1000}s` : '',
    engine.minItemLengthMs ? `minimum item ${engine.minItemLengthMs / 60_000} min` : '',
    settings.webhook.enabled ? `webhooks on port ${settings.webhook.port}${settings.webhook.advertisedUrl ? ' with a manual address' : ''}` : 'webhooks off',
    settings.commands.length ? `${settings.commands.length} command${settings.commands.length === 1 ? '' : 's'}` : '',
  ];
  return parts.filter(Boolean).join(', ');
}

function prefixed(log: Logger, name: string): Logger {
  return {
    debug: (message, ...parameters) => log.debug(`${name}: ${message}`, ...parameters),
    info: (message, ...parameters) => log.info(`${name}: ${message}`, ...parameters),
    warn: (message, ...parameters) => log.warn(`${name}: ${message}`, ...parameters),
    error: (message, ...parameters) => log.error(`${name}: ${message}`, ...parameters),
  };
}
