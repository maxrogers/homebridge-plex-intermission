import type { Marker, MediaInfo, PlaybackState, PlayingNotification, SessionInfo, WebhookEvent } from '../engine/types.js';
import type { PlexMarker, PlexMetadata, PlexNotificationContainer, PlexPlayer, PlexWebhookPayload } from './types.js';

const PLAYBACK_STATES = new Set<string>(['playing', 'paused', 'buffering', 'stopped']);

export function toNumber(value: unknown): number | undefined {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : undefined;
}

function toBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  return value === true || value === 1 || value === '1' || value === 'true';
}

function toMedia(metadata: PlexMetadata): MediaInfo {
  const title = metadata.grandparentTitle && metadata.title
    ? `${metadata.grandparentTitle}: ${metadata.title}`
    : (metadata.title ?? '');
  const section = metadata.librarySectionID;
  return {
    ratingKey: String(metadata.ratingKey ?? ''),
    title,
    type: metadata.type ?? 'unknown',
    durationMs: toNumber(metadata.duration),
    librarySectionId: section === undefined ? undefined : String(section),
    librarySectionTitle: metadata.librarySectionTitle,
  };
}

function toSession(playerId: string, player: PlexPlayer | undefined, user: string | undefined, metadata: PlexMetadata): SessionInfo {
  return {
    playerId,
    playerTitle: player?.title,
    product: player?.product,
    platform: player?.platform,
    user,
    local: toBoolean(player?.local),
    media: toMedia(metadata),
  };
}

/** Session info from an entry of `/status/sessions`. */
export function sessionFromMetadata(metadata: PlexMetadata): SessionInfo | undefined {
  const playerId = metadata.Player?.machineIdentifier;
  if (!playerId || metadata.ratingKey === undefined) {
    return undefined;
  }
  return toSession(playerId, metadata.Player, metadata.User?.title, metadata);
}

export function webhookFromPayload(payload: PlexWebhookPayload): WebhookEvent | undefined {
  if (typeof payload.event !== 'string') {
    return undefined;
  }
  const playerId = payload.Player?.uuid;
  const metadata = payload.Metadata;
  const session = playerId && metadata?.ratingKey !== undefined
    ? toSession(playerId, payload.Player, payload.Account?.title, metadata)
    : undefined;
  return {
    event: payload.event,
    owner: payload.owner === true,
    user: payload.Account?.title,
    serverId: payload.Server?.uuid,
    session,
    viewOffset: toNumber(metadata?.viewOffset),
  };
}

export function markersFromMetadata(items: readonly PlexMetadata[]): Marker[] {
  return items.flatMap((item) => item.Marker ?? []).flatMap((marker: PlexMarker) => {
    const startMs = toNumber(marker.startTimeOffset);
    const endMs = toNumber(marker.endTimeOffset);
    if (!marker.type || startMs === undefined) {
      return [];
    }
    return [{ type: marker.type, startMs, endMs: endMs ?? startMs, final: toBoolean(marker.final) ?? false }];
  });
}

/** Parses one websocket message. Returns its type and any playback notifications in it. */
export function parseNotification(data: string): { type: string; playing: PlayingNotification[] } | undefined {
  let message: PlexNotificationContainer;
  try {
    message = JSON.parse(data) as PlexNotificationContainer;
  } catch {
    return undefined;
  }
  const container = message.NotificationContainer;
  if (!container?.type) {
    return undefined;
  }
  const playing = (container.PlaySessionStateNotification ?? []).flatMap((entry) => {
    const viewOffset = toNumber(entry.viewOffset);
    if (!entry.clientIdentifier || !entry.sessionKey || !entry.ratingKey || viewOffset === undefined
      || !entry.state || !PLAYBACK_STATES.has(entry.state)) {
      return [];
    }
    return [{
      sessionKey: String(entry.sessionKey),
      clientIdentifier: entry.clientIdentifier,
      ratingKey: String(entry.ratingKey),
      state: entry.state as PlaybackState,
      viewOffset,
    }];
  });
  return { type: container.type, playing };
}
