import { EventEmitter } from 'node:events';

import type { Clock, TimerHandle } from './clock.js';
import { creditsRanges, type CreditsRange } from './credits.js';
import type {
  EngineEvent,
  EngineEventType,
  EngineSettings,
  Logger,
  Marker,
  PlaybackState,
  PlayerActivity,
  PlayerSnapshot,
  PlayingNotification,
  SessionInfo,
  WebhookEvent,
} from './types.js';

export interface EngineDependencies {
  clock: Clock;
  log: Logger;
  /** Looks up player, user and media for a session that arrived without a webhook. */
  resolveSession(playerId: string, sessionKey: string): Promise<SessionInfo | undefined>;
  getMarkers(ratingKey: string): Promise<readonly Marker[]>;
}

interface PlayerRecord {
  readonly id: string;
  /** Incremented whenever the session is replaced, so late async results are discarded. */
  generation: number;
  ratingKey?: string;
  sessionKey?: string;
  session?: SessionInfo;
  ready: boolean;
  ignored: boolean;
  raw: PlaybackState;
  activity: PlayerActivity;
  positionMs: number;
  observedAt: number;
  /** False until Plex has reported a position for the current item. */
  positionKnown: boolean;
  /** Where the credits are: empty when there are none, undefined until markers are known. */
  credits: CreditsRange[] | undefined;
  /** True when the latest position report was a jump backwards. */
  jumpedBack: boolean;
  inCredits: boolean;
  creditsTimer?: TimerHandle;
  pauseTimer?: TimerHandle;
  stopTimer?: TimerHandle;
}

const ACTIVE = new Set<PlaybackState>(['playing', 'buffering']);

/** Allowance for timers firing a millisecond early or late. */
const TIMER_TOLERANCE_MS = 1;

/**
 * Turns Plex server notifications and webhooks into playback events per player.
 *
 * Both sources report the same changes a few milliseconds apart; every input is applied
 * idempotently, so whichever arrives first wins and the other changes nothing.
 */
export class PlaybackEngine extends EventEmitter<{ event: [EngineEvent] }> {
  private readonly players = new Map<string, PlayerRecord>();

  constructor(
    private readonly deps: EngineDependencies,
    private readonly settings: EngineSettings,
  ) {
    super();
  }

  handleNotification(notification: PlayingNotification): void {
    const player = this.player(notification.clientIdentifier);
    if (notification.state === 'stopped') {
      // A late stop for the previous item must not end the one that replaced it.
      if (player.ratingKey === notification.ratingKey) {
        this.stop(player);
      }
      return;
    }
    const fresh = this.isNewSession(player, notification.ratingKey, notification.sessionKey);
    if (fresh) {
      this.resetSession(player, notification.ratingKey, notification.sessionKey);
    } else {
      player.sessionKey ??= notification.sessionKey;
    }
    this.observe(player, notification.viewOffset, fresh);
    this.setRaw(player, notification.state);
    if (fresh) {
      this.resolve(player);
    }
  }

  handleWebhook(webhook: WebhookEvent): void {
    const session = webhook.session;
    if (!session) {
      return;
    }
    const player = this.player(session.playerId);
    switch (webhook.event) {
      case 'media.play':
      case 'media.resume': {
        const fresh = this.isNewSession(player, session.media.ratingKey);
        if (fresh) {
          this.resetSession(player, session.media.ratingKey);
        }
        if (webhook.viewOffset !== undefined) {
          this.observe(player, webhook.viewOffset, fresh);
        }
        this.setRaw(player, 'playing');
        if (!player.ready) {
          this.resolve(player, session);
        }
        break;
      }
      case 'media.pause':
        if (player.ratingKey === session.media.ratingKey) {
          if (webhook.viewOffset !== undefined) {
            this.observe(player, webhook.viewOffset, false);
          }
          this.setRaw(player, 'paused');
        }
        break;
      case 'media.stop':
        if (player.ratingKey === session.media.ratingKey) {
          this.stop(player);
        }
        break;
    }
  }

  snapshot(playerId: string): PlayerSnapshot {
    const player = this.players.get(playerId);
    return {
      playerId,
      activity: player?.ignored ? 'idle' : (player?.activity ?? 'idle'),
      inCredits: player?.inCredits ?? false,
      positionMs: player ? Math.round(this.position(player)) : 0,
      session: player?.session,
    };
  }

  snapshots(): PlayerSnapshot[] {
    return [...this.players.keys()].map((id) => this.snapshot(id));
  }

  /** Clears all timers. Call on shutdown. */
  dispose(): void {
    for (const player of this.players.values()) {
      this.clearTimers(player);
    }
    this.players.clear();
    this.removeAllListeners();
  }

  private player(id: string): PlayerRecord {
    let player = this.players.get(id);
    if (!player) {
      player = {
        id,
        generation: 0,
        ready: false,
        ignored: false,
        raw: 'stopped',
        activity: 'idle',
        positionMs: 0,
        observedAt: this.deps.clock.now(),
        positionKnown: false,
        credits: undefined,
        jumpedBack: false,
        inCredits: false,
      };
      this.players.set(id, player);
    }
    return player;
  }

  private isNewSession(player: PlayerRecord, ratingKey: string, sessionKey?: string): boolean {
    if (player.ratingKey !== ratingKey) {
      return true;
    }
    return sessionKey !== undefined && player.sessionKey !== undefined && player.sessionKey !== sessionKey;
  }

  /**
   * Forgets the current item and starts tracking `ratingKey`, if given. Activity is kept, so autoplay to
   * the next item never passes through idle.
   */
  private resetSession(player: PlayerRecord, ratingKey?: string, sessionKey?: string): void {
    this.clearTimers(player);
    player.generation += 1;
    player.ratingKey = ratingKey;
    player.sessionKey = sessionKey;
    player.session = undefined;
    player.ready = false;
    player.ignored = false;
    player.positionKnown = false;
    player.credits = undefined;
    player.jumpedBack = false;
    player.inCredits = false;
  }

  private resolve(player: PlayerRecord, known?: SessionInfo): void {
    const generation = player.generation;
    if (known) {
      this.complete(player, generation, known);
      return;
    }
    const ratingKey = player.ratingKey ?? '';
    this.deps.resolveSession(player.id, player.sessionKey ?? '').then(
      (session) => this.complete(player, generation, session ?? unknownSession(player.id, ratingKey)),
      (error: unknown) => {
        this.deps.log.warn('Could not read the Plex session for %s: %s', player.id, describe(error));
        this.complete(player, generation, unknownSession(player.id, ratingKey));
      },
    );
  }

  private complete(player: PlayerRecord, generation: number, session: SessionInfo): void {
    if (generation !== player.generation || player.ready) {
      return;
    }
    player.session = session;
    player.ready = true;
    const durationMs = session.media.durationMs;
    const minimum = this.settings.minItemLengthMs;
    player.ignored = minimum > 0 && durationMs !== undefined && durationMs < minimum;
    if (player.ignored) {
      this.deps.log.debug('%s: ignoring "%s", shorter than the minimum item length', label(player), session.media.title);
      return;
    }

    if (ACTIVE.has(player.raw)) {
      player.activity = 'playing';
      this.emitEvent(player, 'play');
    } else if (player.raw === 'paused') {
      player.activity = 'paused';
    }

    this.deps.getMarkers(session.media.ratingKey).then(
      (markers) => this.applyMarkers(player, generation, markers),
      (error: unknown) => {
        this.deps.log.warn('Could not read credits markers for "%s": %s', session.media.title, describe(error));
        this.applyMarkers(player, generation, []);
      },
    );
  }

  private applyMarkers(player: PlayerRecord, generation: number, markers: readonly Marker[]): void {
    if (generation !== player.generation) {
      return;
    }
    player.credits = creditsRanges(markers, player.session?.media.durationMs, this.settings, player.session?.media.type);
    this.deps.log.debug('%s: credits %s', label(player), player.credits.length === 0
      ? 'none'
      : player.credits.map((r) => `${formatTime(r.startMs)}-${r.endMs === Infinity ? 'end' : formatTime(r.endMs)}`).join(', '));
    this.scheduleCredits(player);
  }

  /** Records a reported position, emitting `seek` when it is far from where playback should be. */
  private observe(player: PlayerRecord, positionMs: number, fresh: boolean): void {
    const now = this.deps.clock.now();
    const expected = this.position(player, now);
    const wasKnown = player.positionKnown;
    player.positionMs = positionMs;
    player.observedAt = now;
    player.positionKnown = true;
    const tracked = wasKnown && !fresh && player.ready && !player.ignored && player.activity !== 'idle';
    const jumped = tracked && Math.abs(positionMs - expected) > this.settings.seekThresholdMs;
    player.jumpedBack = jumped && positionMs < expected;
    if (jumped) {
      this.emitEvent(player, 'seek');
    }
  }

  private setRaw(player: PlayerRecord, raw: PlaybackState): void {
    player.raw = raw;
    if (player.stopTimer !== undefined) {
      this.deps.clock.clearTimeout(player.stopTimer);
      player.stopTimer = undefined;
    }
    if (!player.ready || player.ignored) {
      return;
    }

    if (ACTIVE.has(raw)) {
      if (player.pauseTimer !== undefined) {
        this.deps.clock.clearTimeout(player.pauseTimer);
        player.pauseTimer = undefined;
      }
      if (player.activity === 'paused') {
        player.activity = 'playing';
        this.emitEvent(player, 'resume');
      } else if (player.activity === 'idle') {
        player.activity = 'playing';
        this.emitEvent(player, 'play');
      }
    } else if (raw === 'paused' && player.activity === 'playing' && player.pauseTimer === undefined) {
      const debounce = this.settings.pauseDebounceMs;
      if (debounce <= 0) {
        this.enterPaused(player);
      } else {
        player.pauseTimer = this.deps.clock.setTimeout(() => {
          player.pauseTimer = undefined;
          if (player.raw === 'paused') {
            this.enterPaused(player);
          }
        }, debounce);
      }
    }
    this.scheduleCredits(player);
  }

  private enterPaused(player: PlayerRecord): void {
    player.activity = 'paused';
    this.emitEvent(player, 'pause');
  }

  private stop(player: PlayerRecord): void {
    player.raw = 'stopped';
    this.clearCreditsTimer(player);
    if (player.pauseTimer !== undefined) {
      this.deps.clock.clearTimeout(player.pauseTimer);
      player.pauseTimer = undefined;
    }
    if (player.stopTimer !== undefined || player.ratingKey === undefined) {
      return;
    }
    if (!player.ready || player.ignored || this.settings.stopHoldMs <= 0) {
      this.finish(player);
      return;
    }
    player.stopTimer = this.deps.clock.setTimeout(() => {
      player.stopTimer = undefined;
      this.finish(player);
    }, this.settings.stopHoldMs);
  }

  private finish(player: PlayerRecord): void {
    if (player.ready && !player.ignored && player.activity !== 'idle') {
      player.activity = 'idle';
      this.emitEvent(player, 'stop');
    }
    this.resetSession(player);
    player.activity = 'idle';
  }

  /**
   * Arms the credits timer from the current position. Called on every new position and state,
   * so seeks and skips move the timer the moment Plex reports them.
   */
  /**
   * Keeps `inCredits` in step with the position and sets a timer for the next credits boundary.
   * Small rewinds (Plex rewinds a little on resume) never change the credits state: a rewind that
   * lands within the re-arm distance of the credits it left keeps it.
   */
  private scheduleCredits(player: PlayerRecord): void {
    this.clearCreditsTimer(player);
    const ranges = player.credits;
    if (!player.ready || player.ignored || !player.positionKnown || !ranges || ranges.length === 0) {
      return;
    }
    const position = this.position(player);
    const offset = this.settings.creditsOffsetMs;
    const rearm = this.settings.rearmDistanceMs;
    const startOf = (range: CreditsRange) => range.startMs + offset;
    const inside = ranges.find((range) => position >= startOf(range) - TIMER_TOLERANCE_MS && position < range.endMs);
    const next = ranges.find((range) => startOf(range) > position);

    if (player.inCredits && !inside) {
      const latched = position < startOf(ranges[0]!)
        ? position >= ranges[0]!.startMs - rearm
        : player.jumpedBack && next !== undefined && startOf(next) - position <= rearm;
      if (!latched) {
        player.inCredits = false;
        this.emitEvent(player, 'credits.cancel');
      }
    } else if (!player.inCredits && inside && ACTIVE.has(player.raw)) {
      // A small rewind from a mid-credits scene back into the end of the credits keeps the scene state.
      const backIntoEnd = player.jumpedBack && inside.endMs !== Infinity && inside.endMs - position <= rearm;
      if (!backIntoEnd) {
        player.inCredits = true;
        this.emitEvent(player, 'credits.start');
      }
    }

    if (player.raw !== 'playing') {
      return;
    }
    const boundary = player.inCredits
      ? (inside && inside.endMs !== Infinity ? inside.endMs : (inside ? undefined : next && startOf(next)))
      : (inside ? inside.endMs : next && startOf(next));
    if (boundary !== undefined && Number.isFinite(boundary)) {
      player.creditsTimer = this.deps.clock.setTimeout(() => {
        player.creditsTimer = undefined;
        player.jumpedBack = false;
        this.scheduleCredits(player);
      }, Math.max(0, boundary - position));
    }
  }

  /** Current position: the last report, advanced by the time since then while playing. */
  private position(player: PlayerRecord, now = this.deps.clock.now()): number {
    return player.positionMs + (player.raw === 'playing' ? now - player.observedAt : 0);
  }

  private emitEvent(player: PlayerRecord, type: EngineEventType): void {
    if (!player.session) {
      return;
    }
    const now = this.deps.clock.now();
    const event: EngineEvent = {
      type,
      at: now,
      playerId: player.id,
      session: player.session,
      positionMs: Math.round(this.position(player, now)),
    };
    this.deps.log.debug('%s: %s at %s', label(player), type, formatTime(event.positionMs));
    this.emit('event', event);
  }

  private clearCreditsTimer(player: PlayerRecord): void {
    if (player.creditsTimer !== undefined) {
      this.deps.clock.clearTimeout(player.creditsTimer);
      player.creditsTimer = undefined;
    }
  }

  private clearTimers(player: PlayerRecord): void {
    this.clearCreditsTimer(player);
    for (const key of ['pauseTimer', 'stopTimer'] as const) {
      if (player[key] !== undefined) {
        this.deps.clock.clearTimeout(player[key]);
        player[key] = undefined;
      }
    }
  }
}

function unknownSession(playerId: string, ratingKey: string): SessionInfo {
  return { playerId, media: { ratingKey, title: '', type: 'unknown' } };
}

function label(player: PlayerRecord): string {
  return player.session?.playerTitle ?? player.id;
}

function formatTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
