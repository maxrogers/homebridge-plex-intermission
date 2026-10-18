import type { NamedCommand } from './commands.js';
import { DEFAULT_ENGINE_SETTINGS, type EngineEventType, type EngineSettings, type Logger } from './engine/types.js';

/** Webhook events that only arrive through Plex webhooks (Plex Pass). */
export const WEBHOOK_EVENTS = [
  'media.scrobble',
  'media.rate',
  'library.new',
  'library.on.deck',
  'playback.started',
  'device.new',
  'admin.database.backup',
  'admin.database.corrupted',
] as const;

export const ENGINE_EVENTS: readonly EngineEventType[] = ['play', 'pause', 'resume', 'stop', 'seek', 'credits.start', 'credits.cancel', 'intro.start', 'intro.end'];

export type WebhookOnlyEvent = (typeof WEBHOOK_EVENTS)[number];
export type TriggerEvent = EngineEventType | WebhookOnlyEvent;

/**
 * What a state sensor follows. Playing, Paused and Playing or paused can leave out the credits
 * and/or the intro (`except`); In the credits and In the intro are those moments themselves.
 */
export const STATE_CONDITIONS = ['playing', 'paused', 'active', 'credits', 'intro', 'idle'] as const;
export type StateCondition = (typeof STATE_CONDITIONS)[number];

/** Moments a Playing, Paused or Playing or paused sensor can leave out. */
export const EXCEPTIONS = ['credits', 'intro'] as const;
export type Exception = (typeof EXCEPTIONS)[number];

export const SENSOR_TYPES = ['occupancy', 'motion', 'contact', 'button'] as const;
export type SensorType = (typeof SENSOR_TYPES)[number];

export interface SensorFilters {
  players: string[];
  users: string[];
  libraries: string[];
  mediaTypes: string[];
}

export interface SensorConfig {
  id: string;
  name: string;
  type: SensorType;
  /** For occupancy, motion and contact sensors. */
  state?: StateCondition;
  /** Moments the sensor turns off for (Playing, Paused, Playing or paused only). */
  except: Exception[];
  /** Command ids to run when a state sensor turns on or off, or a button is pressed. */
  run: { on: string[]; off: string[]; press: string[] };
  /** For buttons. */
  events: TriggerEvent[];
  filters: SensorFilters;
}

export interface ServerConfig {
  id: string;
  name: string;
  url: string;
}

export interface WebhookConfig {
  enabled: boolean;
  port: number;
  /** Address Plex should post to, when the automatic one is wrong (for example behind NAT). */
  advertisedUrl?: string;
}

export interface IntermissionConfig {
  name: string;
  /** Links the config to the saved sign-in; see Credentials.setupId. */
  setupId?: string;
  /** Servers to watch. Older configs with a single `server` are read as a list of one. */
  servers: ServerConfig[];
  sensors: SensorConfig[];
  webhook: WebhookConfig;
  engine: EngineSettings;
  /** How often to re-read sessions while the notification stream is down and something plays. 0 disables. */
  safetyResyncMs: number;
  detailedLogging: boolean;
  /** Named commands; empty when the feature is off. */
  commands: NamedCommand[];
}

export const DEFAULT_WEBHOOK_PORT = 32550;
/** Used for movies and episodes that have no credits marker, unless the user turns it off. */
export const DEFAULT_FALLBACK_PERCENT = 95;

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw => (value && typeof value === 'object' && !Array.isArray(value) ? value as Raw : {});
const asString = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);
const asStrings = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap((v) => asString(v) ?? []) : []);

function seconds(raw: Raw, key: string, fallbackMs: number, min: number, max: number): number {
  const value = raw[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallbackMs;
  }
  return Math.round(Math.min(max, Math.max(min, value)) * 1000);
}

/**
 * Reads the platform block of config.json. Unknown or out-of-range values fall back to defaults
 * or are clamped to the documented ranges; invalid sensors are skipped with a warning.
 */
export function parseConfig(raw: unknown, log: Logger): IntermissionConfig {
  const config = asRecord(raw);
  const timing = asRecord(config.timing);
  const webhook = asRecord(config.webhook);
  const server = asRecord(config.server);

  const fallback = timing.fallbackPercent;
  const engine: EngineSettings = {
    creditsOffsetMs: seconds(timing, 'creditsOffset', DEFAULT_ENGINE_SETTINGS.creditsOffsetMs, 0, 120),
    creditsMode: timing.midCredits === 'first' || timing.midCredits === 'final' || timing.midCredits === 'scenes'
      ? timing.midCredits
      : (timing.firstCreditsMarker === false ? 'final' : DEFAULT_ENGINE_SETTINGS.creditsMode),
    fallbackPercent: fallback === null
      ? null
      : (typeof fallback === 'number' && Number.isFinite(fallback) ? Math.min(99, Math.max(50, Math.round(fallback))) : DEFAULT_FALLBACK_PERCENT),
    rearmDistanceMs: seconds(timing, 'rearmDistance', DEFAULT_ENGINE_SETTINGS.rearmDistanceMs, 20, 600),
    pauseDebounceMs: seconds(timing, 'pauseDebounce', DEFAULT_ENGINE_SETTINGS.pauseDebounceMs, 0, 30),
    stopHoldMs: seconds(timing, 'stopHold', DEFAULT_ENGINE_SETTINGS.stopHoldMs, 0, 60),
    minItemLengthMs: seconds(timing, 'minItemLength', DEFAULT_ENGINE_SETTINGS.minItemLengthMs, 0, 3600),
    seekThresholdMs: DEFAULT_ENGINE_SETTINGS.seekThresholdMs,
  };

  // Minutes: 0 turns it off, otherwise 1 to 30.
  const safetyResyncMs = timing.safetyResync === 0 ? 0 : seconds(timing, 'safetyResync', 5_000, 1, 30) * 60;

  const port = webhook.port;

  return {
    name: asString(config.name) ?? 'Intermission',
    setupId: asString(config.setupId),
    servers: parseServers(Array.isArray(config.servers) ? config.servers : (config.server ? [server] : [])),
    sensors: parseSensors(config.sensors, log),
    webhook: {
      enabled: webhook.enabled !== false,
      port: typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_WEBHOOK_PORT,
      advertisedUrl: asString(webhook.advertisedUrl),
    },
    engine,
    safetyResyncMs,
    detailedLogging: config.detailedLogging === true,
    commands: parseCommands(config.commands),
  };
}

function parseCommands(value: unknown): NamedCommand[] {
  const section = asRecord(value);
  if (section.enabled !== true || !Array.isArray(section.list)) {
    return [];
  }
  return section.list.flatMap((entry) => {
    const command = asRecord(entry);
    const id = asString(command.id);
    const name = asString(command.name);
    const line = asString(command.command);
    return id && name && line ? [{ id, name, command: line }] : [];
  });
}

function parseServers(value: unknown[]): ServerConfig[] {
  const seen = new Set<string>();
  return value.flatMap((entry) => {
    const server = asRecord(entry);
    const id = asString(server.id);
    const url = asString(server.url);
    if (!id || !url || seen.has(id)) {
      return [];
    }
    seen.add(id);
    return [{ id, name: asString(server.name) ?? 'Plex', url }];
  });
}

function parseSensors(value: unknown, log: Logger): SensorConfig[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const known = new Set<string>([...ENGINE_EVENTS, ...WEBHOOK_EVENTS]);
  const seen = new Set<string>();
  return value.flatMap((entry, index) => {
    const sensor = asRecord(entry);
    const id = asString(sensor.id);
    const name = asString(sensor.name);
    const type = SENSOR_TYPES.find((t) => t === sensor.type);
    if (!id || !name || !type || seen.has(id)) {
      log.warn('Skipping sensor %d: it needs a unique id, a name and a type.', index + 1);
      return [];
    }
    seen.add(id);
    const filters = asRecord(sensor.filters);
    const parsed: SensorConfig = {
      id,
      name,
      type,
      events: [],
      except: [],
      run: {
        on: asStrings(asRecord(sensor.run).on),
        off: asStrings(asRecord(sensor.run).off),
        press: asStrings(asRecord(sensor.run).press),
      },
      filters: {
        players: asStrings(filters.players),
        users: asStrings(filters.users),
        libraries: asStrings(filters.libraries),
        mediaTypes: asStrings(filters.mediaTypes),
      },
    };
    if (type === 'button') {
      parsed.events = asStrings(sensor.events).filter((event): event is TriggerEvent => known.has(event));
      if (parsed.events.length === 0) {
        log.warn('Sensor "%s" has no events, so it will never trigger.', name);
      }
    } else {
      // Older configs: "playing-any" was playing including the credits; "playing" and "paused" left the credits out.
      const raw = sensor.state === 'playing-any' ? 'playing' : sensor.state;
      parsed.state = STATE_CONDITIONS.find((c) => c === raw) ?? 'playing';
      const excepted = Array.isArray(sensor.except)
        ? asStrings(sensor.except).filter((e): e is Exception => (EXCEPTIONS as readonly string[]).includes(e))
        : (sensor.state === 'playing' || sensor.state === 'paused' ? ['credits' as const] : []);
      parsed.except = ['playing', 'paused', 'active'].includes(parsed.state) ? [...new Set(excepted)] : [];
    }
    return [parsed];
  });
}
