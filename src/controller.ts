import type { EventEmitter } from 'node:events';

import { WEBHOOK_EVENTS, type IntermissionConfig, type SensorConfig, type TriggerEvent } from './config.js';
import type { Clock, TimerHandle } from './engine/clock.js';
import { PlaybackEngine } from './engine/engine.js';
import type { EngineEvent, Logger, Marker, PlayingNotification, SessionInfo, WebhookEvent } from './engine/types.js';
import { webhookFromPayload } from './plex/convert.js';
import type { PlexWebhookPayload } from './plex/types.js';
import { PlexHttpError } from './plex/server.js';
import { contextOf, matchesFilters, stateHolds, type MatchContext } from './sensors/rules.js';

/** The parts of PlexServer the controller uses. */
export interface ServerApi {
  playing(): Promise<PlayingNotification[]>;
  session(playerId: string, sessionKey: string): Promise<SessionInfo | undefined>;
}

export interface StreamApi extends EventEmitter<{
  playing: [PlayingNotification];
  notification: [type: string];
  connected: [];
  disconnected: [];
}> {
  readonly isConnected: boolean;
  start(): void;
  stop(): void;
}

export interface WebhookApi extends EventEmitter<{ payload: [unknown] }> {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** A HomeKit output. */
export interface SensorOutput {
  readonly config: SensorConfig;
  setActive(active: boolean): void;
  press(): void;
}

export interface ControllerOptions {
  config: IntermissionConfig;
  log: Logger;
  clock: Clock;
  server: ServerApi;
  stream: StreamApi;
  webhooks?: WebhookApi;
  getMarkers(ratingKey: string): Promise<readonly Marker[]>;
  sensors: readonly SensorOutput[];
  /** Called once when Plex rejects the saved sign-in. */
  onUnauthorized?(): void;
}

const WEBHOOK_ONLY = new Set<string>(WEBHOOK_EVENTS);

/**
 * Connects Plex to the sensors: notifications and webhooks go into the playback engine, engine
 * events press buttons, and every change re-evaluates the state sensors.
 */
export class Controller {
  readonly engine: PlaybackEngine;
  private resyncTimer?: TimerHandle;
  private resyncing = false;
  private unauthorized = false;
  private stopped = true;

  constructor(private readonly options: ControllerOptions) {
    this.engine = new PlaybackEngine({
      clock: options.clock,
      log: options.log,
      resolveSession: (playerId, sessionKey) => this.call(() => options.server.session(playerId, sessionKey), undefined),
      getMarkers: (ratingKey) => this.call(() => options.getMarkers(ratingKey), []),
    }, options.config.engine);

    this.engine.on('event', (event) => this.onEngineEvent(event));
    options.stream.on('playing', (notification) => this.engine.handleNotification(notification));
    options.stream.on('connected', () => {
      options.log.info('Connected to Plex.');
      this.cancelResync();
      void this.resync();
    });
    options.stream.on('disconnected', () => {
      if (!this.stopped) {
        options.log.warn('Lost the connection to Plex. Reconnecting.');
        this.scheduleResync();
      }
    });
    options.webhooks?.on('payload', (payload) => this.onWebhook(payload));
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.refreshStates();
    this.options.stream.start();
    if (this.options.webhooks) {
      try {
        await this.options.webhooks.start();
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        this.options.log.error(code === 'EADDRINUSE'
          ? 'Cannot receive Plex webhooks: port %d is in use. Choose another port in the plugin settings.'
          : 'Cannot receive Plex webhooks on port %d: %s', this.options.config.webhook.port, (error as Error).message);
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelResync();
    this.options.stream.stop();
    this.engine.dispose();
    await this.options.webhooks?.stop();
  }

  /**
   * Reads current sessions and applies them, ending players Plex no longer lists. Runs when the
   * notification stream connects (including at start), and periodically while it is down.
   */
  async resync(): Promise<void> {
    if (this.resyncing || this.stopped) {
      return;
    }
    this.resyncing = true;
    try {
      const playing = await this.options.server.playing();
      const live = new Set(playing.map((entry) => entry.clientIdentifier));
      for (const snapshot of this.engine.snapshots()) {
        const ratingKey = snapshot.session?.media.ratingKey;
        if (snapshot.activity !== 'idle' && ratingKey && !live.has(snapshot.playerId)) {
          this.engine.handleNotification({
            clientIdentifier: snapshot.playerId,
            ratingKey,
            sessionKey: '',
            state: 'stopped',
            viewOffset: snapshot.positionMs,
          });
        }
      }
      for (const entry of playing) {
        this.engine.handleNotification(entry);
      }
    } catch (error) {
      this.report(error, 'Cannot read playback from Plex');
    } finally {
      this.resyncing = false;
      if (!this.options.stream.isConnected) {
        this.scheduleResync();
      }
    }
  }

  private onEngineEvent(event: EngineEvent): void {
    const { log } = this.options;
    log.debug('%s: %s on %s at %ds', event.type, event.session.media.title,
      event.session.playerTitle ?? event.playerId, Math.round(event.positionMs / 1000));
    this.pressButtons(event.type, contextOf(event.session));
    this.refreshStates();
    if (!this.options.stream.isConnected) {
      this.scheduleResync();
    }
  }

  private onWebhook(raw: unknown): void {
    const webhook = webhookFromPayload((raw ?? {}) as PlexWebhookPayload);
    if (!webhook) {
      return;
    }
    const serverId = this.options.config.server?.id;
    if (serverId && webhook.serverId && webhook.serverId !== serverId) {
      this.options.log.debug('Ignoring %s from another server.', webhook.event);
      return;
    }
    this.options.log.debug('Webhook %s', webhook.event);
    this.engine.handleWebhook(webhook);
    if (WEBHOOK_ONLY.has(webhook.event)) {
      this.pressButtons(webhook.event as TriggerEvent, this.webhookContext(webhook));
    }
  }

  private webhookContext(webhook: WebhookEvent): MatchContext {
    const context = contextOf(webhook.session, webhook.media);
    return { ...context, user: context.user ?? webhook.user };
  }

  private pressButtons(event: TriggerEvent, context: MatchContext): void {
    for (const sensor of this.options.sensors) {
      if (sensor.config.type === 'button' && sensor.config.events.includes(event) && matchesFilters(sensor.config.filters, context)) {
        this.options.log.info('%s: %s', sensor.config.name, event);
        sensor.press();
      }
    }
  }

  /** A state sensor is on when any player that passes its filters meets its condition. */
  private refreshStates(): void {
    const snapshots = this.engine.snapshots();
    for (const sensor of this.options.sensors) {
      const condition = sensor.config.state;
      if (sensor.config.type === 'button' || !condition) {
        continue;
      }
      sensor.setActive(snapshots.some((snapshot) => snapshot.session !== undefined
        && matchesFilters(sensor.config.filters, contextOf(snapshot.session))
        && stateHolds(condition, snapshot)));
    }
  }

  private scheduleResync(): void {
    const interval = this.options.config.safetyResyncMs;
    if (interval <= 0 || this.resyncTimer || this.stopped) {
      return;
    }
    const anyActive = this.engine.snapshots().some((snapshot) => snapshot.activity !== 'idle');
    // While idle, the reconnect itself triggers a re-sync; nothing to watch until then.
    if (!anyActive) {
      return;
    }
    this.resyncTimer = this.options.clock.setTimeout(() => {
      this.resyncTimer = undefined;
      void this.resync();
    }, interval);
  }

  private cancelResync(): void {
    if (this.resyncTimer) {
      this.options.clock.clearTimeout(this.resyncTimer);
      this.resyncTimer = undefined;
    }
  }

  private async call<T>(request: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await request();
    } catch (error) {
      this.report(error, 'Plex request failed');
      return fallback;
    }
  }

  private report(error: unknown, context: string): void {
    if (error instanceof PlexHttpError && error.status === 401) {
      if (!this.unauthorized) {
        this.unauthorized = true;
        this.options.log.error('Plex no longer accepts the saved sign-in. Open the plugin settings and sign in again.');
        this.options.onUnauthorized?.();
      }
      return;
    }
    this.options.log.warn('%s: %s', context, error instanceof Error ? error.message : String(error));
  }
}
