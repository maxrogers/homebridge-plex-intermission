import type { SessionInfo } from './engine/types.js';
import { describe } from './errors.js';
import type { Storage } from './storage.js';

/** A player Intermission has seen play. */
export interface SeenPlayer {
  name?: string;
  product?: string;
  platform?: string;
  /** LAN address, from the server's session list. */
  address?: string;
  /** Whether Plex called it local the last time it played. */
  local?: boolean;
  /** When it last started playing (ISO date). */
  lastPlayedAt: string;
}

/** Where a player name was seen playing, in order, for telling two devices with one name apart. */
interface NameSighting {
  address: string;
  at: string;
}

export interface PlayerRecords {
  seen: Record<string, SeenPlayer>;
  /** New player IDs followed as chosen ones: new ID to the chosen IDs it stands for. */
  followed: Record<string, string[]>;
  /** Recent addresses per player name (lower case), oldest first. */
  sightings: Record<string, NameSighting[]>;
  /** Player names that two devices report (lower case), with when that was last seen. */
  sharedNames: Record<string, string>;
}

/** Seen players are forgotten after this long without playing. */
const FORGET_AFTER_MS = 90 * 24 * 60 * 60 * 1000;
/** Sightings kept per name, and how far back they count. */
const SIGHTINGS_KEPT = 12;
const SIGHTINGS_MS = 30 * 24 * 60 * 60 * 1000;

const key = (name: string) => name.trim().toLowerCase();
const same = (a?: string, b?: string) => a !== undefined && b !== undefined && key(a) === key(b);

/**
 * Remembers players as they play: name, app, LAN address and whether Plex calls them local.
 *
 * - Plex gives an app a new ID when it is reinstalled or signed in again, and some filters hold IDs.
 *   A new ID with the same name, app and address as a chosen app is followed as it; one with the
 *   same name and address as an app pinned to a device is followed as that app, whatever the app.
 * - Addresses are only evidence: an address shared by players on different platforms is not
 *   trusted (Plex behind Docker Desktop or rootless Docker sees every player at one address).
 * - A name seen at one address, then another, then the first again belongs to two devices; an
 *   address change only moves it once.
 *
 * Kept in `players.json`; the settings page reads it too.
 */
export class PlayerBook {
  private records: PlayerRecords = emptyRecords();
  private saving = Promise.resolve();

  constructor(
    private readonly storage: Pick<Storage, 'readPlayers' | 'writePlayers'>,
    private readonly onError: (message: string) => void = () => undefined,
  ) {}

  async load(now = new Date()): Promise<void> {
    this.records = parseRecords(await this.storage.readPlayers().catch(() => undefined));
    const cutoff = now.getTime() - FORGET_AFTER_MS;
    for (const [id, player] of Object.entries(this.records.seen)) {
      if (Date.parse(player.lastPlayedAt) < cutoff) {
        delete this.records.seen[id];
        delete this.records.followed[id];
      }
    }
  }

  /** The chosen players a player is followed as. */
  followedAs(playerId: string | undefined): string[] {
    return playerId ? this.records.followed[playerId] ?? [] : [];
  }

  get(playerId: string): SeenPlayer | undefined {
    return this.records.seen[playerId];
  }

  /** Whether players on one device can be told apart from others by this address. */
  trusted(address: string | undefined): boolean {
    if (!address) {
      return false;
    }
    const here = Object.values(this.records.seen).filter((p) => p.address === address);
    const platforms = new Set(here.flatMap((p) => (p.platform ? [key(p.platform)] : [])));
    const names = new Set(here.flatMap((p) => (p.name ? [key(p.name)] : [])));
    return platforms.size <= 1 && names.size <= 2;
  }

  /** Whether two devices have been seen reporting this name. */
  isShared(name: string | undefined): boolean {
    return name !== undefined && this.records.sharedNames[key(name)] !== undefined;
  }

  /**
   * Records a player that started playing. When it is not chosen, not left out and not yet
   * followed, returns the chosen players it is followed as from now on (see the class comment).
   * `pinned` holds apps pinned to devices, which need the same name and address but not the same app.
   */
  record(session: SessionInfo, chosen: ReadonlySet<string>, options: { ignored?: readonly string[]; pinned?: ReadonlySet<string> } = {}, now = new Date())
    : { followed: string[]; newlyShared: boolean } {
    const { playerId } = session;
    const before = this.records.seen[playerId];
    const player: SeenPlayer = {
      name: session.playerTitle ?? before?.name,
      product: session.product ?? before?.product,
      platform: session.platform ?? before?.platform,
      address: session.address ?? before?.address,
      local: session.local ?? before?.local,
      lastPlayedAt: now.toISOString(),
    };
    this.records.seen[playerId] = player;
    const newlyShared = session.address !== undefined && player.name !== undefined && this.sighting(player.name, session.address, now);

    let followed: string[] = [];
    if (!chosen.has(playerId) && !(options.ignored ?? []).includes(playerId) && !this.records.followed[playerId]
      && player.name && session.address && this.trusted(session.address)) {
      followed = [...chosen].filter((id) => {
        const other = this.records.seen[id];
        return other !== undefined && other.address === session.address && same(other.name, player.name)
          && (options.pinned?.has(id) === true || same(other.product, player.product));
      });
      if (followed.length > 0) {
        this.records.followed[playerId] = followed;
      }
    }
    this.save();
    return { followed, newlyShared };
  }

  /** Adds a sighting; true when it shows for the first time that two devices report this name. */
  private sighting(name: string, address: string, now: Date): boolean {
    if (!this.trusted(address)) {
      return false;
    }
    const k = key(name);
    const recent = (this.records.sightings[k] ?? []).filter((s) => now.getTime() - Date.parse(s.at) < SIGHTINGS_MS);
    if (recent.at(-1)?.address !== address) {
      recent.push({ address, at: now.toISOString() });
    } else {
      recent[recent.length - 1] = { address, at: now.toISOString() };
    }
    this.records.sightings[k] = recent.slice(-SIGHTINGS_KEPT);
    // Back at an address after another one: an address change moves a device once, never back.
    const earlier = recent.slice(0, -2).some((s) => s.address === address);
    const wasShared = this.records.sharedNames[k] !== undefined;
    if (earlier) {
      this.records.sharedNames[k] = now.toISOString();
    }
    return earlier && !wasShared;
  }

  private save(): void {
    const snapshot = structuredClone(this.records);
    this.saving = this.saving
      .then(() => this.storage.writePlayers(snapshot))
      .catch((error: unknown) => this.onError(`Could not save players.json: ${describe(error)}`));
  }

  /** Resolves once pending writes finish. */
  flush(): Promise<void> {
    return this.saving;
  }
}

const emptyRecords = (): PlayerRecords => ({ seen: {}, followed: {}, sightings: {}, sharedNames: {} });

const object = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});

export function parseRecords(value: unknown): PlayerRecords {
  const raw = object(value);
  const records = emptyRecords();
  for (const [id, entry] of Object.entries(object(raw.seen))) {
    const player = object(entry);
    if (typeof player.lastPlayedAt === 'string') {
      records.seen[id] = {
        lastPlayedAt: player.lastPlayedAt,
        ...Object.fromEntries((['name', 'product', 'platform', 'address'] as const)
          .filter((k) => typeof player[k] === 'string').map((k) => [k, player[k]])),
        ...(typeof player.local === 'boolean' ? { local: player.local } : {}),
      };
    }
  }
  for (const [id, targets] of Object.entries(object(raw.followed))) {
    if (Array.isArray(targets) && targets.length > 0 && targets.every((t) => typeof t === 'string')) {
      records.followed[id] = targets as string[];
    }
  }
  for (const [name, list] of Object.entries(object(raw.sightings))) {
    if (Array.isArray(list)) {
      records.sightings[name] = list.flatMap((s) => {
        const sighting = object(s);
        return typeof sighting.address === 'string' && typeof sighting.at === 'string' ? [{ address: sighting.address, at: sighting.at }] : [];
      });
    }
  }
  for (const [name, at] of Object.entries(object(raw.sharedNames))) {
    if (typeof at === 'string') {
      records.sharedNames[name] = at;
    }
  }
  return records;
}
