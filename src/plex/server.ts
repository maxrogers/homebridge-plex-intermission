import type { Marker, SessionInfo } from '../engine/types.js';
import { markersFromMetadata, sessionFromMetadata } from './convert.js';
import type { PlexMediaContainer, PlexMetadata } from './types.js';

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

  private async metadata(path: string): Promise<PlexMetadata[]> {
    const body = await this.request<PlexMediaContainer<PlexMetadata>>(path);
    return body.MediaContainer?.Metadata ?? [];
  }

  private async request<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
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
    return (await response.json()) as T;
  }
}
