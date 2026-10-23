import type { EventEmitter } from 'node:events';

import { hasMediaConditions, WEBHOOK_EVENTS, type IntermissionConfig, type SensorConfig, type ServerConfig, type TriggerEvent } from './config.js';
import type { Clock, TimerHandle } from './engine/clock.js';
import { PlaybackEngine } from './engine/engine.js';
import type { EngineEvent, Logger, Marker, PlayingNotification, SessionInfo, WebhookEvent } from './engine/types.js';
import { webhookFromPayload } from './plex/convert.js';
import type { PlexWebhookPayload } from './plex/types.js';
import { PlexHttpError } from './plex/server.js';
import type { MediaFacts } from './plex/media-facts.js';
import { person as markPerson, player as markPlayer, title as markTitle } from './diagnostics.js';
import { describe } from './errors.js';
import { contextOf, filterMismatch, matchesFilters, mediaMatches, mediaMismatch, stateHolds, type MatchContext } from './sensors/rules.js';

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

/** Webhook payloads. The platform owns the receiver, shared by every server's controller. */
export type WebhookApi = EventEmitter<{ payload: [unknown] }>;

/** What was playing when a sensor changed, for commands. */
export interface ChangeContext {
  event?: string;
  session?: SessionInfo;
}

/** A HomeKit sensor or button, as one server's controller sees it. */
export interface SensorOutput {
  readonly config: SensorConfig;
  setActive(active: boolean, context?: ChangeContext): void;
  press(context?: ChangeContext): void;
}

export interface ControllerOptions {
  config: IntermissionConfig;
  /** The server this controller watches. */
  server: ServerConfig;
  log: Logger;
  clock: Clock;
  plex: ServerApi;
  stream: StreamApi;
  webhooks?: WebhookApi;
  getMarkers(ratingKey: string): Promise<readonly Marker[]>;
  /** Whether an item can have credits; see EngineDependencies.hasCredits. */
  hasCredits?(media: SessionInfo['media']): boolean | Promise<boolean>;
  /** Picture, rating and labels of an item, for sensors with media conditions. */
  getFacts?(ratingKey: string): Promise<MediaFacts | undefined>;
  sensors: readonly SensorOutput[];
  /** Called once when Plex rejects the saved sign-in. */
  onUnauthorized?(): void;
}

const WEBHOOK_ONLY = new Set<string>(WEBHOOK_EVENTS);

/** How long sensors keep their state from before a restart when Plex cannot be read. */
const STARTUP_GRACE_MS = 20_000;

/** Media details kept per item; plenty for a night of TV. */
const FACTS_CACHE_SIZE = 200;

/**
 * Connects Plex to the sensors: notifications and webhooks go into the playback engine, engine
 * events press buttons, and every change re-evaluates the state sensors.
 */
export class Controller {
  readonly engine: PlaybackEngine;
  private resyncTimer?: TimerHandle;
  /**
   * False until the first sync with Plex. Until then the sensors keep the state they had before
   * Homebridge restarted, so a hub reconnecting early never sees "Nothing Playing" mid-movie.
   */
  private ready = false;
  private readyTimer?: TimerHandle;
  private resyncing = false;
  private unauthorized = false;
  private stopped = true;
  /** Media details by rating key: a value once read, or null while reading or when Plex had none. */
  private readonly facts = new Map<string, MediaFacts | null>();
  private readonly needsFacts: boolean;

  constructor(private readonly options: ControllerOptions) {
    this.engine = new PlaybackEngine({
      clock: options.clock,
      log: options.log,
      resolveSession: (playerId, sessionKey) => this.call(() => options.plex.session(playerId, sessionKey), undefined),
      getMarkers: (ratingKey) => this.call(() => options.getMarkers(ratingKey), []),
      hasCredits: options.hasCredits,
    }, options.config.engine);

    this.needsFacts = options.getFacts !== undefined && options.sensors.some((s) => s.config.type !== 'button' && hasMediaConditions(s.config.media));
    this.engine.on('event', (event) => this.onEngineEvent(event));
    options.stream.on('playing', (notification) => this.engine.handleNotification(notification));
    options.stream.on('connected', () => {
      options.log.info('Connected to %s.', options.server.name);
      this.cancelResync();
      void this.resync();
    });
    options.stream.on('disconnected', () => {
      if (!this.stopped) {
        options.log.warn('Lost the connection to %s. Reconnecting.', options.server.name);
        this.scheduleResync();
      }
    });
    options.webhooks?.on('payload', (payload) => this.onWebhook(payload));
  }

  start(): void {
    this.stopped = false;
    this.ready = false;
    this.readyTimer = this.options.clock.setTimeout(() => this.becomeReady(true), STARTUP_GRACE_MS);
    this.options.stream.start();
  }

  private becomeReady(fromTimer = false): void {
    if (this.readyTimer) {
      this.options.clock.clearTimeout(this.readyTimer);
      this.readyTimer = undefined;
    }
    if (!this.ready && !this.stopped) {
      if (fromTimer) {
        this.options.log.debug('No playback read from Plex within %ds of starting; sensors follow playback from now.', STARTUP_GRACE_MS / 1000);
      } else {
        this.options.log.debug('Playback read from Plex; sensors follow it from now (until then they kept their state from before the restart).');
      }
      this.ready = true;
      this.refreshStates();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.readyTimer) {
      this.options.clock.clearTimeout(this.readyTimer);
      this.readyTimer = undefined;
    }
    this.cancelResync();
    this.options.stream.stop();
    this.engine.dispose();
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
      const playing = await this.options.plex.playing();
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
      if (playing.length === 0) {
        // Nothing plays: the state is known now. Otherwise the first playback event makes it known.
        this.becomeReady();
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
    log.debug('%s: %s on %s at %ds', event.type, markTitle(event.session.media.title),
      markPlayer(event.session.playerTitle ?? event.playerId), Math.round(event.positionMs / 1000));
    if (event.type === 'play') {
      this.explainSensors(event.session);
    }
    // States first: a button press is delivered to the hub at once and flushes queued state changes
    // with it, so a shortcut started by the press already sees the new states.
    if (this.ready) {
      this.refreshStates();
    } else {
      this.becomeReady();
    }
    this.pressButtons(event.type, contextOf(event.session, undefined, this.options.server.id), event.session);
    if (!this.options.stream.isConnected) {
      this.scheduleResync();
    }
  }

  private onWebhook(raw: unknown): void {
    const webhook = webhookFromPayload((raw ?? {}) as PlexWebhookPayload);
    if (!webhook) {
      return;
    }
    if (webhook.serverId && webhook.serverId !== this.options.server.id) {
      this.options.log.debug('Ignoring %s from another server.', webhook.event);
      return;
    }
    const session = webhook.session;
    this.options.log.debug('Webhook %s%s', webhook.event, session
      ? ` from ${markPlayer(session.playerTitle ?? session.playerId)} (${webhook.user ? markPerson(webhook.user) : 'unknown person'}), ${markTitle(session.media.title)}`
      : webhook.media ? `: ${markTitle(webhook.media.title)}` : '');
    this.engine.handleWebhook(webhook);
    if (WEBHOOK_ONLY.has(webhook.event)) {
      this.pressButtons(webhook.event as TriggerEvent, this.webhookContext(webhook), webhook.session);
    }
  }

  private webhookContext(webhook: WebhookEvent): MatchContext {
    const context = contextOf(webhook.session, webhook.media, this.options.server.id);
    return { ...context, user: context.user ?? webhook.user };
  }

  private pressButtons(event: TriggerEvent, context: MatchContext, session?: SessionInfo): void {
    for (const sensor of this.options.sensors) {
      if (sensor.config.type === 'button' && sensor.config.events.includes(event) && matchesFilters(sensor.config.filters, context)) {
        this.options.log.info('%s: %s', sensor.config.name, event);
        sensor.press({ event, session });
      }
    }
  }

  /** A state sensor is on when any player that passes its filters meets its condition. */
  private refreshStates(): void {
    if (!this.ready) {
      return;
    }
    const snapshots = this.engine.snapshots();
    const updates: { sensor: SensorOutput; active: boolean; session?: SessionInfo }[] = [];
    for (const sensor of this.options.sensors) {
      const condition = sensor.config.state;
      if (sensor.config.type === 'button' || !condition) {
        continue;
      }
      const matching = snapshots.filter((snapshot) => snapshot.session !== undefined
        && matchesFilters(sensor.config.filters, contextOf(snapshot.session, undefined, this.options.server.id))
        && (!hasMediaConditions(sensor.config.media) || mediaMatches(sensor.config.media, this.factsFor(snapshot.session.media))));
      // "Nothing playing" is on while no matching player is busy; the rest are on while any player meets them.
      const holding = matching.find((snapshot) => stateHolds(condition, snapshot, sensor.config.except));
      updates.push({
        sensor,
        active: condition === 'idle' ? matching.every((snapshot) => stateHolds('idle', snapshot)) : holding !== undefined,
        session: (holding ?? matching[0])?.session,
      });
    }
    // Turn states off before turning others on, so nothing ever sees two states at once.
    for (const { sensor, active, session } of [...updates.filter((u) => !u.active), ...updates.filter((u) => u.active)]) {
      sensor.setActive(active, { session });
    }
  }

  /**
   * Media details for an item, or undefined until they are read. The first request starts the read;
   * the states are refreshed again when it finishes, so a matching sensor turns on a moment later.
   */
  private factsFor(media: SessionInfo['media']): MediaFacts | undefined {
    if (!this.needsFacts || media.live || !media.ratingKey) {
      return undefined;
    }
    const known = this.facts.get(media.ratingKey);
    if (known !== undefined) {
      return known ?? undefined;
    }
    this.facts.set(media.ratingKey, null);
    if (this.facts.size > FACTS_CACHE_SIZE) {
      this.facts.delete(this.facts.keys().next().value!);
    }
    void this.call(() => this.options.getFacts!(media.ratingKey), undefined).then((facts) => {
      if (facts) {
        this.facts.set(media.ratingKey, facts);
        this.options.log.debug('Media details for "%s": %j', markTitle(media.title), facts);
        this.refreshStates();
        const session = this.engine.snapshots().find((s) => s.session?.media.ratingKey === media.ratingKey)?.session;
        if (session) {
          this.explainSensors(session, true);
        }
      }
    });
    return undefined;
  }

  /**
   * Detailed logging: which state sensors this playback counts for, and why not for the others.
   * Logged when an item starts, and again for media conditions once the item's details are read.
   */
  private explainSensors(session: SessionInfo, mediaOnly = false): void {
    const context = contextOf(session, undefined, this.options.server.id);
    for (const sensor of this.options.sensors) {
      const config = sensor.config;
      if (config.type === 'button' || (mediaOnly && !hasMediaConditions(config.media))) {
        continue;
      }
      const reason = filterMismatch(config.filters, context, { player: session.playerTitle, product: session.product, library: session.media.librarySectionTitle })
        ?? (hasMediaConditions(config.media) ? mediaMismatch(config.media, this.factsFor(session.media)) : undefined);
      this.options.log.debug('  %s: %s', config.name, reason ? `ignores this playback: ${reason}` : 'follows this playback');
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
    this.options.log.warn('%s: %s', context, describe(error));
  }
}
