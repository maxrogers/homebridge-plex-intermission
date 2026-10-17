import type { Marker, PlaybackState, PlayingNotification, SessionInfo } from '../engine/types.js';
import { markersFromMetadata, sessionFromMetadata, toNumber } from './convert.js';
import type { PlexMediaContainer, PlexMetadata } from './types.js';

export interface PlexLibrary {
  id: string;
  title: string;
  /** Plex section type: movie, show, artist or photo. */
  type: string;
  /** Metadata agent; "Other Videos" libraries are movie sections with no agent. */
  agent?: string;
}

/** Server preferences that affect Intermission. Missing when the token is not the owner's. */
export interface PlexServerPrefs {
  creditsDetection?: string;
  webhooksEnabled?: boolean;
  playedThreshold?: number;
  playedAtBehaviour?: number;
}

export interface PlexServerAccount {
  id: string;
  name: string;
}

export interface PlexServerDevice {
  /** Server-local device number used by play history. */
  id: string;
  clientIdentifier: string;
  name: string;
  platform?: string;
}

export interface PlexHistoryEntry {
  deviceId: string;
  accountId: string;
  viewedAt: number;
}

export interface PlexServerOptions {
  /** For example `http://10.0.0.2:32400`. */
  baseUrl: string;
  token: string;
  clientIdentifier: string;
  timeoutMs?: number;
}

export class PlexHttpError extends Error {
  constructor(
    readonly status: number,
    path: string,
  ) {
    super(`Plex returned HTTP ${status} for ${path}`);
    this.name = 'PlexHttpError';
  }
}

/** Requests to a Plex Media Server. The token is sent as a header and never appears in URLs or messages. */
export class PlexServer {
  private readonly baseUrl: string;

  constructor(private readonly options: PlexServerOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
  }

  async sessions(): Promise<SessionInfo[]> {
    const items = await this.metadata('/status/sessions');
    return items.flatMap((item) => sessionFromMetadata(item) ?? []);
  }

  async session(playerId: string, sessionKey: string): Promise<SessionInfo | undefined> {
    const items = await this.metadata('/status/sessions');
    const match = items.find((item) => item.Player?.machineIdentifier === playerId && String(item.sessionKey) === sessionKey)
      ?? items.find((item) => item.Player?.machineIdentifier === playerId);
    return match ? sessionFromMetadata(match) : undefined;
  }

  /** Current playback as notifications, used to restore state on start and after reconnecting. */
  async playing(): Promise<PlayingNotification[]> {
    const items = await this.metadata('/status/sessions');
    return items.flatMap((item) => {
      const state = item.Player?.state;
      const viewOffset = toNumber(item.viewOffset);
      if (!item.Player?.machineIdentifier || item.sessionKey === undefined || item.ratingKey === undefined
        || viewOffset === undefined || !state || !['playing', 'paused', 'buffering'].includes(state)) {
        return [];
      }
      return [{
        clientIdentifier: item.Player.machineIdentifier,
        sessionKey: String(item.sessionKey),
        ratingKey: String(item.ratingKey),
        state: state as PlaybackState,
        viewOffset,
      }];
    });
  }

  async identity(): Promise<{ machineIdentifier: string; version: string }> {
    const body = await this.request<{ MediaContainer?: { machineIdentifier?: string; version?: string } }>('/identity');
    return { machineIdentifier: body.MediaContainer?.machineIdentifier ?? '', version: body.MediaContainer?.version ?? '' };
  }

  async libraries(): Promise<PlexLibrary[]> {
    const body = await this.request<{ MediaContainer?: { Directory?: Record<string, unknown>[] } }>('/library/sections');
    return (body.MediaContainer?.Directory ?? []).map((d) => ({
      id: String(d.key ?? ''),
      title: String(d.title ?? ''),
      type: String(d.type ?? ''),
      agent: typeof d.agent === 'string' ? d.agent : undefined,
    }));
  }

  async prefs(): Promise<PlexServerPrefs> {
    const body = await this.request<{ MediaContainer?: { Setting?: { id?: string; value?: unknown }[] } }>('/:/prefs');
    const settings = new Map((body.MediaContainer?.Setting ?? []).map((s) => [s.id, s.value]));
    const number = (key: string) => toNumber(settings.get(key));
    const credits = settings.get('GenerateCreditsMarkerBehavior');
    const webhooks = settings.get('WebHooksEnabled');
    return {
      creditsDetection: credits === undefined ? undefined : String(credits),
      webhooksEnabled: webhooks === undefined ? undefined : webhooks === true || webhooks === 1 || webhooks === '1' || webhooks === 'true',
      playedThreshold: number('LibraryVideoPlayedThreshold'),
      playedAtBehaviour: number('LibraryVideoPlayedAtBehaviour'),
    };
  }

  async accounts(): Promise<PlexServerAccount[]> {
    const body = await this.request<{ MediaContainer?: { Account?: Record<string, unknown>[] } }>('/accounts');
    return (body.MediaContainer?.Account ?? [])
      .map((a) => ({ id: String(a.id ?? ''), name: String(a.name ?? '') }))
      .filter((a) => a.name);
  }

  async devices(): Promise<PlexServerDevice[]> {
    const body = await this.request<{ MediaContainer?: { Device?: Record<string, unknown>[] } }>('/devices');
    return (body.MediaContainer?.Device ?? [])
      .map((d) => ({
        id: String(d.id ?? ''),
        clientIdentifier: String(d.clientIdentifier ?? ''),
        name: String(d.name ?? ''),
        platform: typeof d.platform === 'string' ? d.platform : undefined,
      }))
      .filter((d) => d.clientIdentifier);
  }

  async history(limit = 200): Promise<PlexHistoryEntry[]> {
    const items = await this.metadata(
      `/status/sessions/history/all?sort=viewedAt:desc&X-Plex-Container-Start=0&X-Plex-Container-Size=${limit}`,
    ) as Record<string, unknown>[];
    return items.map((h) => ({ deviceId: String(h.deviceID ?? ''), accountId: String(h.accountID ?? ''), viewedAt: Number(h.viewedAt ?? 0) * 1000 }));
  }

  async markers(ratingKey: string): Promise<Marker[]> {
    const items = await this.metadata(`/library/metadata/${encodeURIComponent(ratingKey)}?includeMarkers=1`);
    return markersFromMetadata(items);
  }

  /** Websocket URL for server notifications. Plex only accepts the token as a query parameter here. */
  notificationsUrl(): string {
    const url = new URL(`${this.baseUrl}/:/websockets/notifications`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('X-Plex-Token', this.options.token);
    return url.toString();
  }

  /** Tries each URL and returns the first that answers as the expected server. */
  static async findWorkingUrl(
    urls: readonly string[],
    options: Omit<PlexServerOptions, 'baseUrl'> & { machineIdentifier?: string },
  ): Promise<string | undefined> {
    for (const url of urls) {
      try {
        const identity = await new PlexServer({ ...options, baseUrl: url, timeoutMs: options.timeoutMs ?? 4_000 }).identity();
        if (!options.machineIdentifier || identity.machineIdentifier === options.machineIdentifier) {
          return url.replace(/\/+$/, '');
        }
      } catch {
        // Try the next one.
      }
    }
    return undefined;
  }

  private async metadata(path: string): Promise<PlexMetadata[]> {
    const body = await this.request<PlexMediaContainer<PlexMetadata>>(path);
    return body.MediaContainer?.Metadata ?? [];
  }

  /** Changes one server preference. Owner token only. */
  async setPref(name: string, value: string | number | boolean): Promise<void> {
    const query = new URLSearchParams({ [name]: typeof value === 'boolean' ? (value ? '1' : '0') : String(value) });
    await this.request<unknown>(`/:/prefs?${query.toString()}`, 'PUT');
  }

  private async request<T>(path: string, method = 'GET'): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        'X-Plex-Token': this.options.token,
        'X-Plex-Client-Identifier': this.options.clientIdentifier,
        'X-Plex-Product': 'Intermission',
      },
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 8_000),
    });
    if (!response.ok) {
      throw new PlexHttpError(response.status, path.split('?')[0]);
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}
