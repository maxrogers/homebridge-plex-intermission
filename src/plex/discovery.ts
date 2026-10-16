import type { PlexDevice, PlexTv } from './plex-tv.js';
import type { PlexLibrary, PlexServer, PlexServerAccount } from './server.js';

export interface DiscoveredPlayer {
  id: string;
  name: string;
  product?: string;
  platform?: string;
  device?: string;
  /** Plays in recent server history. */
  plays: number;
  lastUsedAt?: number;
  playingNow: boolean;
}

export interface Discovery {
  players: DiscoveredPlayer[];
  users: PlexServerAccount[];
  libraries: PlexLibrary[];
}

/**
 * Everything the setup page offers to choose from. Players combine the devices signed in to the
 * account, the server's device list and play history, and current sessions, most used first.
 * Each source is optional; a failing one only narrows the list.
 */
export async function discover(server: PlexServer, plexTv: PlexTv, accountToken: string): Promise<Discovery> {
  const settle = <T>(promise: Promise<T>, fallback: T) => promise.catch(() => fallback);
  const [accountDevices, serverDevices, history, sessions, users, libraries] = await Promise.all([
    settle(plexTv.devices(accountToken), [] as PlexDevice[]),
    settle(server.devices(), []),
    settle(server.history(), []),
    settle(server.sessions(), []),
    settle(server.accounts(), []),
    settle(server.libraries(), []),
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
  const byServerId = new Map(serverDevices.map((device) => [device.id, device]));
  for (const entry of history) {
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
  for (const session of sessions) {
    upsert(session.playerId, {
      name: session.playerTitle,
      product: session.product,
      platform: session.platform,
      playingNow: true,
      lastUsedAt: Date.now(),
    });
  }

  const ranked = [...players.values()].sort((a, b) =>
    Number(b.playingNow) - Number(a.playingNow) || b.plays - a.plays || (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
  return {
    players: ranked,
    users,
    libraries: libraries.filter((library) => ['movie', 'show', 'artist', 'photo'].includes(library.type)),
  };
}
