import { EventEmitter } from 'node:events';

import { player as markPlayer, title as markTitle } from '../diagnostics.js';
import type { Clock, TimerHandle } from './clock.js';
import { CREDITED_TYPES, creditsRanges, type CreditsRange } from './credits.js';
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
  /**
   * Whether an item can have credits. Defaults to movies and episodes; the platform also excludes
   * "Other Videos" libraries, whose items are movies to Plex but have no credits.
   */
  hasCredits?(media: SessionInfo['media']): boolean | Promise<boolean>;
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
  /** Intro markers, empty when there are none. */
  intro: CreditsRange[];
  inIntro: boolean;
  introTimer?: TimerHandle;
  creditsTimer?: TimerHandle;
  pauseTimer?: TimerHandle;
  stopTimer?: TimerHandle;
  /** The item that stopped, while the stop hold runs. */
  stoppedRatingKey?: string;
  /** Retry of a session lookup that found nothing. */
  resolveTimer?: TimerHandle;
  /**
   * True when Plex's session list had no entry for this player and a placeholder session is in use.
   * The next webhook for the same item replaces it.
   */
  provisional: boolean;
}

const ACTIVE = new Set<PlaybackState>(['playing', 'buffering']);

/** Allowance for timers firing a millisecond early or late. */
const TIMER_TOLERANCE_MS = 1;

/**
 * Hold for a stop away from the end of an item. Autoplay can't follow such a stop, but some players
 * report stopped and playing again within milliseconds while seeking.
 */
export const QUICK_STOP_HOLD_MS = 1_000;

/** A stop within this much of the end, or in the final tenth of the runtime, waits the full stop hold. */
const END_ZONE_MS = 60_000;
const END_ZONE_FRACTION = 0.9;

/**
 * Plex can briefly leave a new session out of /status/sessions. A lookup that finds nothing is retried
 * this often before a placeholder is used; the webhook for the same play usually arrives first.
 */
const SESSION_RETRY_MS = 1_000;
const SESSION_RETRIES = 2;

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
    if (notification.state !== player.raw || notification.ratingKey !== player.ratingKey) {
      this.deps.log.debug('%s: Plex reports %s at %s (item %s)', label(player), notification.state, formatTime(notification.viewOffset), notification.ratingKey);
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
        } else if (player.provisional && player.ratingKey === session.media.ratingKey) {
          this.adopt(player, session);
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
      inIntro: player?.inIntro ?? false,
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
        intro: [],
        inIntro: false,
        provisional: false,
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
    player.provisional = false;
    player.positionKnown = false;
    player.credits = undefined;
    player.jumpedBack = false;
    player.inCredits = false;
    player.intro = [];
    player.inIntro = false;
  }

  private resolve(player: PlayerRecord, known?: SessionInfo, attempt = 0): void {
    const generation = player.generation;
    if (known) {
      this.complete(player, generation, known);
      return;
    }
    const ratingKey = player.ratingKey ?? '';
    const placeholder = () => {
      if (generation === player.generation && !player.ready) {
        player.provisional = true;
        this.complete(player, generation, unknownSession(player.id, ratingKey));
      }
    };
    this.deps.resolveSession(player.id, player.sessionKey ?? '').then(
      (session) => {
        if (generation !== player.generation || player.ready) {
          return;
        }
        if (session) {
          this.complete(player, generation, session);
        } else if (attempt < SESSION_RETRIES) {
          this.deps.log.debug('%s: Plex does not list this session yet; checking again in %ds', label(player), SESSION_RETRY_MS / 1000);
          player.resolveTimer = this.deps.clock.setTimeout(() => {
            player.resolveTimer = undefined;
            if (generation === player.generation && !player.ready) {
              this.resolve(player, undefined, attempt + 1);
            }
          }, SESSION_RETRY_MS);
        } else {
          placeholder();
        }
      },
      (error: unknown) => {
        this.deps.log.warn('Could not read the Plex session for %s: %s', player.id, describe(error));
        placeholder();
      },
    );
  }

  /** Replaces a placeholder session with the one a webhook brought, so sensors see the real player and item. */
  private adopt(player: PlayerRecord, session: SessionInfo): void {
    this.deps.log.debug('%s: player and item now known from the webhook', label({ ...player, session }));
    this.clearCreditsTimer(player);
    if (player.introTimer !== undefined) {
      this.deps.clock.clearTimeout(player.introTimer);
      player.introTimer = undefined;
    }
    player.generation += 1;
    player.ready = false;
    player.provisional = false;
    player.credits = undefined;
    player.inCredits = false;
    player.intro = [];
    player.inIntro = false;
    this.complete(player, player.generation, session);
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
      this.deps.log.debug('%s: ignoring "%s", shorter than the minimum item length', label(player), markTitle(session.media.title));
      return;
    }

    if (ACTIVE.has(player.raw)) {
      player.activity = 'playing';
      this.emitEvent(player, 'play');
    } else if (player.raw === 'paused') {
      player.activity = 'paused';
    }

    const credited = Promise.resolve(this.deps.hasCredits?.(session.media) ?? CREDITED_TYPES.has(session.media.type))
      .catch(() => CREDITED_TYPES.has(session.media.type));
    Promise.all([session.media.live ? [] : this.deps.getMarkers(session.media.ratingKey), credited]).then(
      ([markers, hasCredits]) => this.applyMarkers(player, generation, markers, hasCredits),
      (error: unknown) => {
        this.deps.log.warn('Could not read credits markers for "%s": %s', markTitle(session.media.title), describe(error));
        void credited.then((hasCredits) => this.applyMarkers(player, generation, [], hasCredits));
      },
    );
  }

  private applyMarkers(player: PlayerRecord, generation: number, markers: readonly Marker[], credited: boolean): void {
    if (generation !== player.generation) {
      return;
    }
    const media = player.session?.media;
    player.credits = credited ? creditsRanges(markers, media?.durationMs, this.settings, media?.type) : [];
    player.intro = markers.filter((marker) => marker.type === 'intro' && marker.endMs > marker.startMs)
      .map((marker) => ({ startMs: marker.startMs, endMs: marker.endMs }));
    const range = (r: { startMs: number; endMs: number }) => `${formatTime(r.startMs)}-${r.endMs === Infinity ? 'end' : formatTime(r.endMs)}`;
    const fromMarkers = markers.some((marker) => marker.type === 'credits');
    this.deps.log.debug('%s: "%s" credits %s; intros %s', label(player), markTitle(media?.title),
      !credited ? `none (${media?.live ? 'Live TV' : 'this library or media type never gets credits'})`
        : player.credits.length === 0 ? 'none (no marker, and the percentage fallback is off)'
          : `${player.credits.map(range).join(', ')}${fromMarkers ? ` (${this.settings.creditsMode} mode)` : ` (no marker: ${this.settings.fallbackPercent}% of the runtime)`}`,
      player.intro.length === 0 ? 'none' : player.intro.map(range).join(', '));
    this.scheduleMarkers(player);
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
      this.deps.log.debug('%s: %s within the stop hold, so it is not a stop', label(player),
        player.ratingKey === player.stoppedRatingKey ? 'playback resumed' : 'the next item started');
    }
    if (!player.ready || player.ignored) {
      return;
    }

    if (ACTIVE.has(raw)) {
      if (player.pauseTimer !== undefined) {
        this.deps.clock.clearTimeout(player.pauseTimer);
        player.pauseTimer = undefined;
        this.deps.log.debug('%s: pause shorter than the pause debounce (%ss), ignored', label(player), this.settings.pauseDebounceMs / 1000);
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
    this.scheduleMarkers(player);
  }

  private enterPaused(player: PlayerRecord): void {
    player.activity = 'paused';
    this.emitEvent(player, 'pause');
  }

  private stop(player: PlayerRecord): void {
    const position = this.position(player);
    if (player.raw === 'playing') {
      // Freeze the position where playback stopped, so the stop event and a resume compare against it.
      player.positionMs = position;
      player.observedAt = this.deps.clock.now();
    }
    player.raw = 'stopped';
    this.clearCreditsTimer(player);
    for (const key of ['pauseTimer', 'introTimer'] as const) {
      if (player[key] !== undefined) {
        this.deps.clock.clearTimeout(player[key]);
        player[key] = undefined;
      }
    }
    if (player.stopTimer !== undefined || player.ratingKey === undefined) {
      return;
    }
    if (!player.ready || player.ignored || this.settings.stopHoldMs <= 0) {
      this.finish(player);
      return;
    }
    player.stoppedRatingKey = player.ratingKey;
    const nearEnd = this.nearEnd(player, position);
    const hold = nearEnd ? this.settings.stopHoldMs : Math.min(QUICK_STOP_HOLD_MS, this.settings.stopHoldMs);
    if (nearEnd) {
      this.deps.log.debug('%s: stopped near the end; waiting %ds (stop hold) in case the next item autoplays', label(player), Math.round(hold / 1000));
    } else {
      this.deps.log.debug('%s: stopped at %s, away from the end; waiting %ss in case playback resumes', label(player), formatTime(position), hold / 1000);
    }
    player.stopTimer = this.deps.clock.setTimeout(() => {
      player.stopTimer = undefined;
      this.finish(player);
    }, hold);
  }

  /**
   * Whether a stop could be followed by autoplay: in or past the credits, in the final tenth of the
   * runtime, or within a minute of the end. An unknown position or runtime counts as near the end (cinema
   * trailers hand off to the movie), except for Live TV.
   */
  private nearEnd(player: PlayerRecord, position: number): boolean {
    if (!player.positionKnown || player.inCredits) {
      return true;
    }
    const first = player.credits?.[0];
    if (first && position >= first.startMs) {
      return true;
    }
    const media = player.session?.media;
    const duration = media?.durationMs;
    if (duration === undefined || duration <= 0) {
      // Live TV never autoplays; anything else without a known runtime is treated as possibly at its end.
      return !media?.live;
    }
    return position >= duration * END_ZONE_FRACTION || duration - position <= END_ZONE_MS;
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
  private scheduleMarkers(player: PlayerRecord): void {
    this.scheduleCredits(player);
    this.scheduleIntro(player);
  }

  /** Keeps `inIntro` in step with the position, with a timer for the next intro boundary. */
  private scheduleIntro(player: PlayerRecord): void {
    if (player.introTimer !== undefined) {
      this.deps.clock.clearTimeout(player.introTimer);
      player.introTimer = undefined;
    }
    if (!player.ready || player.ignored || !player.positionKnown || player.intro.length === 0) {
      return;
    }
    const position = this.position(player);
    const inside = player.intro.find((range) => position >= range.startMs - TIMER_TOLERANCE_MS && position < range.endMs);
    if (inside && !player.inIntro && player.raw !== 'stopped') {
      player.inIntro = true;
      this.emitEvent(player, 'intro.start');
    } else if (!inside && player.inIntro) {
      player.inIntro = false;
      this.emitEvent(player, 'intro.end');
    }
    if (player.raw !== 'playing') {
      return;
    }
    const next = inside ? inside.endMs : player.intro.find((range) => range.startMs > position)?.startMs;
    if (next !== undefined) {
      player.introTimer = this.deps.clock.setTimeout(() => {
        player.introTimer = undefined;
        this.scheduleIntro(player);
      }, Math.max(0, next - position));
    }
  }

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
    for (const key of ['pauseTimer', 'stopTimer', 'introTimer', 'resolveTimer'] as const) {
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

function label(record: PlayerRecord): string {
  return markPlayer(record.session?.playerTitle ?? record.id);
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
