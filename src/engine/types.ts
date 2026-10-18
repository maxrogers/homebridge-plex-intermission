import type { CreditsMode } from './credits.js';

/** Player state as Plex reports it. */
export type PlaybackState = 'playing' | 'paused' | 'buffering' | 'stopped';

/** One entry of a Plex `playing` server notification. */
export interface PlayingNotification {
  sessionKey: string;
  clientIdentifier: string;
  ratingKey: string;
  state: PlaybackState;
  viewOffset: number;
}

export interface MediaInfo {
  ratingKey: string;
  title: string;
  /** Plex metadata type: movie, episode, track, clip. */
  type: string;
  durationMs?: number;
  librarySectionId?: string;
  librarySectionTitle?: string;
}

/** Who is playing what, where. Used for sensor filters. */
export interface SessionInfo {
  playerId: string;
  playerTitle?: string;
  product?: string;
  platform?: string;
  user?: string;
  local?: boolean;
  media: MediaInfo;
}

export interface Marker {
  type: string;
  startMs: number;
  endMs: number;
  final: boolean;
}

/** A Plex webhook reduced to what the engine and filters need. */
export interface WebhookEvent {
  event: string;
  owner: boolean;
  user?: string;
  serverId?: string;
  /** Present when a player is involved (playback events). */
  session?: SessionInfo;
  /** The item the event is about, also for events without a player such as `library.new`. */
  media?: MediaInfo;
  viewOffset?: number;
}

export type EngineEventType = 'play' | 'pause' | 'resume' | 'stop' | 'seek' | 'credits.start' | 'credits.cancel' | 'intro.start' | 'intro.end';

export interface EngineEvent {
  type: EngineEventType;
  at: number;
  playerId: string;
  session: SessionInfo;
  positionMs: number;
}

export type PlayerActivity = 'idle' | 'playing' | 'paused';

export interface PlayerSnapshot {
  playerId: string;
  activity: PlayerActivity;
  inCredits: boolean;
  /** Inside an intro marker (Plex finds intros on servers with Plex Pass). */
  inIntro: boolean;
  positionMs: number;
  session?: SessionInfo;
}

export interface EngineSettings {
  /** Delay after the credits marker before `credits.start`. Never negative. */
  creditsOffsetMs: number;
  /** How mid-credits scenes are handled; see CreditsMode. */
  creditsMode: CreditsMode;
  /** Percentage of the runtime used when an item has no credits marker, or null for none. */
  fallbackPercent: number | null;
  /** How far before the credits a seek must land to leave the credits state. */
  rearmDistanceMs: number;
  /** Pauses shorter than this are ignored. */
  pauseDebounceMs: number;
  /** Time a stop waits for new playback (autoplay) before it counts. */
  stopHoldMs: number;
  /** Items shorter than this are ignored. 0 disables. */
  minItemLengthMs: number;
  /** A position jump larger than this is reported as a seek. */
  seekThresholdMs: number;
}

export const DEFAULT_ENGINE_SETTINGS: Readonly<EngineSettings> = {
  creditsOffsetMs: 0,
  creditsMode: 'scenes',
  fallbackPercent: null,
  rearmDistanceMs: 60_000,
  pauseDebounceMs: 2_000,
  stopHoldMs: 10_000,
  minItemLengthMs: 0,
  seekThresholdMs: 5_000,
};

export interface Logger {
  debug(message: string, ...parameters: unknown[]): void;
  info(message: string, ...parameters: unknown[]): void;
  warn(message: string, ...parameters: unknown[]): void;
  error(message: string, ...parameters: unknown[]): void;
}
