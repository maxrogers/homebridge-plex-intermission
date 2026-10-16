import { PlexHttpError } from './server.js';

export interface PlexTvOptions {
  clientIdentifier: string;
  product?: string;
  /** Overridable for tests. */
  baseUrl?: string;
  timeoutMs?: number;
}

export interface PlexPin {
  id: number;
  code: string;
}

export interface PlexUser {
  id: number;
  username: string;
  title: string;
  plexPass: boolean;
}

export interface PlexConnection {
  uri: string;
  address: string;
  port: number;
  protocol: string;
  local: boolean;
  relay: boolean;
}

export interface PlexServerResource {
  id: string;
  name: string;
  owned: boolean;
  accessToken?: string;
  connections: PlexConnection[];
}

export interface PlexDevice {
  id: string;
  name: string;
  product?: string;
  platform?: string;
  device?: string;
  lastSeenAt?: number;
}

const PRODUCT = 'Intermission for Plex';

/** plex.tv requests: sign-in, account, servers and devices. */
export class PlexTv {
  private readonly baseUrl: string;

  constructor(private readonly options: PlexTvOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://plex.tv').replace(/\/+$/, '');
  }

  /** `strong` PINs are for the browser sign-in page; short ones can be entered at plex.tv/link. */
  async createPin(strong: boolean): Promise<PlexPin> {
    const body = await this.request<{ id?: number; code?: string }>(`/api/v2/pins?strong=${strong}`, { method: 'POST' });
    if (typeof body.id !== 'number' || typeof body.code !== 'string') {
      throw new Error('plex.tv returned an unexpected PIN response');
    }
    return { id: body.id, code: body.code };
  }

  /** Returns the token once the PIN has been claimed. */
  async checkPin(pin: PlexPin): Promise<string | undefined> {
    const body = await this.request<{ authToken?: string | null }>(`/api/v2/pins/${pin.id}?code=${encodeURIComponent(pin.code)}`);
    return body.authToken || undefined;
  }

  authUrl(pin: PlexPin): string {
    const params = new URLSearchParams({
      clientID: this.options.clientIdentifier,
      code: pin.code,
      'context[device][product]': this.options.product ?? PRODUCT,
    });
    return `https://app.plex.tv/auth#?${params.toString()}`;
  }

  async user(token: string): Promise<PlexUser> {
    const body = await this.request<{ id?: number; username?: string; title?: string; subscription?: { active?: boolean } }>('/api/v2/user', { token });
    return {
      id: body.id ?? 0,
      username: body.username ?? body.title ?? '',
      title: body.title ?? body.username ?? '',
      plexPass: body.subscription?.active === true,
    };
  }

  async servers(token: string): Promise<PlexServerResource[]> {
    const body = await this.request<unknown>('/api/v2/resources?includeHttps=1&includeRelay=1', { token });
    const resources = Array.isArray(body) ? body as Record<string, unknown>[] : [];
    return resources
      .filter((resource) => String(resource.provides ?? '').split(',').includes('server'))
      .map((resource) => ({
        id: String(resource.clientIdentifier ?? ''),
        name: String(resource.name ?? 'Plex Media Server'),
        owned: resource.owned === true,
        accessToken: typeof resource.accessToken === 'string' ? resource.accessToken : undefined,
        connections: (Array.isArray(resource.connections) ? resource.connections as Record<string, unknown>[] : []).map((c) => ({
          uri: String(c.uri ?? ''),
          address: String(c.address ?? ''),
          port: Number(c.port ?? 32400),
          protocol: String(c.protocol ?? 'http'),
          local: c.local === true,
          relay: c.relay === true,
        })),
      }))
      .filter((server) => server.id);
  }

  /** Players signed in to the account. */
  async devices(token: string): Promise<PlexDevice[]> {
    const xml = await this.request<string>('/devices.xml', { token, text: true });
    const attribute = (tag: string, name: string) => (new RegExp(`\\s${name}="([^"]*)"`).exec(tag) ?? [])[1];
    return [...xml.matchAll(/<Device\s[^>]*>/g)]
      .map((match) => match[0])
      .filter((tag) => /\b(player|client)\b/.test(attribute(tag, 'provides') ?? ''))
      .map((tag) => ({
        id: decodeXml(attribute(tag, 'clientIdentifier') ?? ''),
        name: decodeXml(attribute(tag, 'name') ?? ''),
        product: decodeXml(attribute(tag, 'product') ?? '') || undefined,
        platform: decodeXml(attribute(tag, 'platform') ?? '') || undefined,
        device: decodeXml(attribute(tag, 'device') ?? '') || undefined,
        lastSeenAt: Number(attribute(tag, 'lastSeenAt')) * 1000 || undefined,
      }))
      .filter((device) => device.id);
  }

  private async request<T>(path: string, init: { method?: string; token?: string; text?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = {
      Accept: init.text ? 'application/xml' : 'application/json',
      'X-Plex-Client-Identifier': this.options.clientIdentifier,
      'X-Plex-Product': this.options.product ?? PRODUCT,
    };
    if (init.token) {
      headers['X-Plex-Token'] = init.token;
    }
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
    });
    if (!response.ok) {
      throw new PlexHttpError(response.status, `plex.tv${path.split('?')[0]}`);
    }
    return (init.text ? await response.text() : await response.json()) as T;
  }
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Orders a server's connections for trying: local before remote, direct before relay,
 * and a plain http address after each local https one.
 */
export function connectionCandidates(server: PlexServerResource): string[] {
  const rank = (c: PlexConnection) => (c.relay ? 2 : 0) + (c.local ? 0 : 1);
  const urls: string[] = [];
  for (const connection of [...server.connections].sort((a, b) => rank(a) - rank(b))) {
    if (connection.uri) {
      urls.push(connection.uri);
    }
    if (connection.local && !connection.relay && connection.address) {
      urls.push(`http://${connection.address}:${connection.port}`);
    }
  }
  return [...new Set(urls)];
}
