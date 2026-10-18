import { LIVE_TV_SECTION } from './convert.js';
import type { PlexDevice, PlexHomeUser, PlexTv } from './plex-tv.js';
import type { PlexLibrary, PlexServer } from './server.js';

export interface DiscoveredPlayer {
  id: string;
  name: string;
  product?: string;
  platform?: string;
  device?: string;
  /** Plays in recent server history, across the chosen servers. */
  plays: number;
  lastUsedAt?: number;
  playingNow: boolean;
}

/** How the settings page presents a library. */
export type LibraryKind = 'movie' | 'show' | 'music' | 'photo' | 'other' | 'livetv';

export interface DiscoveredLibrary extends PlexLibrary {
  /** `serverId/sectionId`, the value sensor filters store. */
  key: string;
  kind: LibraryKind;
}

export interface DiscoveredServer {
  id: string;
  name: string;
  libraries: DiscoveredLibrary[];
  /** Set when the server could not be read. */
  error?: string;
}

export interface DiscoveredUser {
  id: string;
  name: string;
  admin: boolean;
  managed: boolean;
}

export interface Discovery {
  players: DiscoveredPlayer[];
  /** Plex Home members. Falls back to the accounts on the servers when the account has no Home. */
  users: DiscoveredUser[];
  servers: DiscoveredServer[];
}

export interface ServerToDiscover {
  id: string;
  name: string;
  server: PlexServer;
}

const NO_AGENT = /(^|\.)none$/;

export function libraryKind(library: Pick<PlexLibrary, 'type' | 'agent'>): LibraryKind {
  switch (library.type) {
    case 'movie':
      return library.agent && NO_AGENT.test(library.agent) ? 'other' : 'movie';
    case 'show':
      return 'show';
    case 'artist':
      return 'music';
    case 'photo':
      return 'photo';
    default:
      return 'other';
  }
}

/**
 * Everything the setup page offers to choose from. Players combine the devices signed in to the
 * account, each server's device list and play history, and current sessions, most used first.
 * Each source is optional; a failing one only narrows the list.
 */
export async function discover(servers: readonly ServerToDiscover[], plexTv: PlexTv, accountToken: string): Promise<Discovery> {
  const settle = <T>(promise: Promise<T>, fallback: T) => promise.catch(() => fallback);
  const [accountDevices, homeUsers, perServer] = await Promise.all([
    settle(plexTv.devices(accountToken), [] as PlexDevice[]),
    settle(plexTv.homeUsers(accountToken), [] as PlexHomeUser[]),
    Promise.all(servers.map(async ({ id, name, server }) => {
      const [devices, history, sessions, accounts, libraries, liveTv] = await Promise.all([
        settle(server.devices(), []),
        settle(server.history(), []),
        settle(server.sessions(), []),
        settle(server.accounts(), []),
        server.libraries().then((items) => ({ items }), (error: unknown) => ({ items: [] as PlexLibrary[], error })),
        settle(server.hasLiveTv(), false),
      ]);
      return { id, name, devices, history, sessions, accounts, libraries, liveTv };
    })),
  ]);

  const players = new Map<string, DiscoveredPlayer>();
  const upsert = (id: string, details: Partial<DiscoveredPlayer>) => {
    const existing = players.get(id) ?? { id, name: details.name || id, plays: 0, playingNow: false };
    players.set(id, {
      ...existing,
      ...Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined && value !== '')),
    });
  };

  for (const device of accountDevices) {
    upsert(device.id, { name: device.name, product: device.product, platform: device.platform, device: device.device, lastUsedAt: device.lastSeenAt });
  }
  for (const server of perServer) {
    const byServerId = new Map(server.devices.map((device) => [device.id, device]));
    for (const entry of server.history) {
      const device = byServerId.get(entry.deviceId);
      if (!device) {
        continue;
      }
      const current = players.get(device.clientIdentifier);
      upsert(device.clientIdentifier, {
        name: current?.name ?? device.name,
        platform: current?.platform ?? device.platform,
        plays: (current?.plays ?? 0) + 1,
        lastUsedAt: Math.max(current?.lastUsedAt ?? 0, entry.viewedAt) || undefined,
      });
    }
    for (const session of server.sessions) {
      upsert(session.playerId, {
        name: session.playerTitle,
        product: session.product,
        platform: session.platform,
        playingNow: true,
        lastUsedAt: Date.now(),
      });
    }
  }

  const users: DiscoveredUser[] = homeUsers.length > 0
    ? homeUsers
    : [...new Map(perServer.flatMap((s) => s.accounts).map((a) => [a.name, { id: a.id, name: a.name, admin: false, managed: false }])).values()];

  return {
    players: [...players.values()].sort((a, b) =>
      Number(b.playingNow) - Number(a.playingNow) || b.plays - a.plays || (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0)),
    users,
    servers: perServer.map((server) => ({
      id: server.id,
      name: server.name,
      libraries: [
        ...server.libraries.items.map((library) => ({ ...library, key: `${server.id}/${library.id}`, kind: libraryKind(library) })),
        // Live TV is not a library to Plex, but choosing it works like one.
        ...(server.liveTv ? [{ id: LIVE_TV_SECTION, title: 'Live TV', type: 'livetv', key: `${server.id}/${LIVE_TV_SECTION}`, kind: 'livetv' as const }] : []),
      ],
      error: 'error' in server.libraries ? describe(server.libraries.error) : undefined,
    })),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
