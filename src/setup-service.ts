import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { NetworkInterfaceInfo } from 'node:os';

import { DEFAULT_WEBHOOK_PORT } from './config.js';
import { discover, type Discovery } from './plex/discovery.js';
import { connectionCandidates, type PlexPin, PlexTv } from './plex/plex-tv.js';
import { PlexHttpError, PlexServer, type PlexServerPrefs } from './plex/server.js';
import { bridgePairing, type BridgePairing } from './child-bridge.js';
import { describe } from './errors.js';
import { lanAddress } from './network.js';
import type { MediaFacts } from './plex/media-facts.js';
import { configFingerprint } from './runtime.js';
import { serverToken, type Credentials, type Storage } from './storage.js';

const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;

/** An error whose message is safe and useful to show on the settings page. */
export class SetupError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'SetupError';
  }
}

export interface ServerRef {
  id: string;
  name: string;
  url: string;
}

export interface WebhookOptions {
  port?: number;
  /** Overrides the address Plex should post to. */
  advertisedUrl?: string;
  servers: ServerRef[];
}

/** Who answers on the webhook port of this machine. */
export type PortState = 'free' | 'intermission' | 'other' | 'unknown';

export interface WebhookStatus {
  plexPass: boolean;
  port: number;
  portState: PortState;
  /** Each chosen server's "Webhooks" network setting; undefined when it cannot be read. */
  serverSettings: { name: string; enabled?: boolean }[];
  /** The address Intermission listens on, as Plex should call it. */
  url?: string;
  registered: boolean;
  /** An Intermission address registered for an old IP or port. */
  stale: string[];
  /** Everyone else's webhooks, kept as they are. */
  others: string[];
  /** Servers whose "Webhooks" setting is off. */
  disabledOn: string[];
}

export interface ReportInput {
  config: Record<string, unknown>;
  servers: ServerRef[];
  homebridgeVersion?: string;
  nodeVersion?: string;
  /** The browser's time zone, for example "America/Denver (UTC-06:00)", since log times are in UTC. */
  timeZone?: string;
}

export interface SetupServiceOptions {
  storage: Storage;
  networkInterfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
  /** For tests. */
  plexTvBaseUrl?: string;
  now?: () => number;
}

/** Everything the settings page asks of Plex. Runs in the Homebridge UI's plugin server. */
export class SetupService {
  private pending?: { pin: PlexPin; startedAt: number };

  constructor(private readonly options: SetupServiceOptions) {}

  get storage(): Storage {
    return this.options.storage;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async plexTv(): Promise<PlexTv> {
    const { clientIdentifier } = await this.options.storage.state();
    return new PlexTv({ clientIdentifier, baseUrl: this.options.plexTvBaseUrl });
  }

  private async credentials(): Promise<Credentials> {
    const credentials = await this.options.storage.readCredentials();
    if (!credentials) {
      throw new SetupError('Not signed in to Plex.', 401);
    }
    return credentials;
  }

  /** A client for one of the chosen servers, with its token. */
  async serverFor(ref: ServerRef, credentials: Credentials): Promise<PlexServer> {
    const { clientIdentifier } = await this.options.storage.state();
    return new PlexServer({ baseUrl: ref.url, token: serverToken(credentials, ref.id), clientIdentifier });
  }

  /**
   * Sign-in state for the config's `setupId`. A saved sign-in that belongs to no config (left
   * behind when the plugin was removed and its config deleted) is erased, so a reinstall starts fresh.
   */
  async status(setupId?: string): Promise<{
    signedIn: boolean; username?: string; plexPass?: boolean; expired?: boolean; warning?: string;
    /** A Plex Pass change the user has not seen yet. */
    plexPassChange?: { active: boolean; changedAt: string };
  }> {
    const credentials = await this.options.storage.readCredentials();
    if (!credentials) {
      return { signedIn: false };
    }
    if (!credentials.setupId || credentials.setupId !== setupId) {
      await this.options.storage.deleteCredentials();
      return { signedIn: false };
    }
    try {
      const user = await (await this.plexTv()).user(credentials.accountToken);
      const record = await this.options.storage.recordPlexPass(user.plexPass, new Date(this.now()));
      return {
        signedIn: true,
        username: user.title || user.username,
        plexPass: user.plexPass,
        plexPassChange: record.acknowledged ? undefined : { active: record.active, changedAt: record.changedAt },
      };
    } catch (error) {
      if (error instanceof PlexHttpError && error.status === 401) {
        return { signedIn: false, expired: true };
      }
      const record = await this.options.storage.readPlexPass();
      return {
        signedIn: true,
        username: credentials.username,
        plexPass: record?.active,
        warning: describe(error),
        plexPassChange: record && !record.acknowledged ? { active: record.active, changedAt: record.changedAt } : undefined,
      };
    }
  }

  async startSignIn(mode: 'browser' | 'code'): Promise<{ authUrl?: string; code?: string; linkUrl?: string }> {
    const plexTv = await this.plexTv();
    const strong = mode !== 'code';
    const pin = await plexTv.createPin(strong);
    this.pending = { pin, startedAt: this.now() };
    return strong ? { authUrl: plexTv.authUrl(pin) } : { code: pin.code, linkUrl: 'https://plex.tv/link' };
  }

  async checkSignIn(): Promise<{ done: boolean; expired?: boolean; username?: string; plexPass?: boolean; setupId?: string }> {
    const pending = this.pending;
    if (!pending) {
      throw new SetupError('Sign-in was not started.');
    }
    if (this.now() - pending.startedAt > SIGN_IN_TIMEOUT_MS) {
      this.pending = undefined;
      return { done: false, expired: true };
    }
    const plexTv = await this.plexTv();
    const token = await plexTv.checkPin(pending.pin);
    if (!token) {
      return { done: false };
    }
    this.pending = undefined;
    const user = await plexTv.user(token);
    const username = user.title || user.username;
    const setupId = randomUUID();
    await this.options.storage.writeCredentials({ accountToken: token, username, savedAt: new Date(this.now()).toISOString(), setupId });
    await this.options.storage.recordPlexPass(user.plexPass, new Date(this.now()));
    return { done: true, username, plexPass: user.plexPass, setupId };
  }

  /**
   * Whether Intermission is running with these saved settings. `running` is false until Homebridge
   * has started the plugin once; `current` is false while saved changes wait for a restart.
   */
  async runtime(config: unknown): Promise<{ running: boolean; current: boolean; startedAt?: string }> {
    const record = await this.options.storage.readRunning();
    return { running: record !== undefined, current: record?.fingerprint === configFingerprint(config), startedAt: record?.startedAt };
  }

  /** What is playing now on the chosen servers, with the details media conditions can use. */
  async nowPlaying(servers: readonly ServerRef[]): Promise<{
    server: string; player: string; user?: string; title: string; type: string; library?: string; live: boolean; facts?: MediaFacts;
  }[]> {
    const credentials = await this.credentials();
    const lists = await Promise.all(servers.map(async (ref) => {
      const plex = await this.serverFor(ref, credentials);
      const sessions = await plex.sessions().catch(() => []);
      return Promise.all(sessions.map(async (session) => ({
        server: ref.name,
        player: session.playerTitle ?? session.playerId,
        user: session.user,
        title: session.media.title,
        type: session.media.type,
        library: session.media.librarySectionTitle,
        live: session.media.live === true,
        facts: session.media.live ? undefined : await plex.facts(session.media.ratingKey).catch(() => undefined),
      })));
    }));
    return lists.flat();
  }

  /** Pairing details of Intermission's own child bridge, by its `_bridge.username`. */
  async bridgePairing(username: string): Promise<BridgePairing> {
    if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i.test(username)) {
      throw new SetupError('Not a child bridge ID.');
    }
    return bridgePairing(dirname(this.options.storage.directory), username);
  }

  acknowledgePlexPass(): Promise<void> {
    return this.options.storage.acknowledgePlexPass();
  }

  /**
   * Full reset: removes Intermission's webhook from the Plex account when possible, then the sign-in
   * and Plex Pass history. The settings page clears the plugin's config.
   */
  async resetPlugin(options: WebhookOptions): Promise<{ webhookRemoved: boolean }> {
    let webhookRemoved = false;
    try {
      if ((await this.options.storage.readCredentials()) && options.servers.length > 0) {
        const status = await this.removeWebhook(options);
        webhookRemoved = status.plexPass && !status.registered;
      }
    } catch {
      // Best effort: the reset must work offline too.
    }
    this.pending = undefined;
    await this.options.storage.reset();
    return { webhookRemoved };
  }

  async signOut(): Promise<{ signedIn: false }> {
    this.pending = undefined;
    await this.options.storage.deleteCredentials();
    return { signedIn: false };
  }

  async servers(): Promise<{ id: string; name: string; owned: boolean }[]> {
    const credentials = await this.credentials();
    const servers = await (await this.plexTv()).servers(credentials.accountToken);
    return servers.map((server) => ({ id: server.id, name: server.name, owned: server.owned }));
  }

  /** Finds a working address for each server and saves its token. */
  async selectServers(ids: readonly string[]): Promise<{ servers: ServerRef[]; failed: { id: string; name: string; error: string }[] }> {
    const credentials = await this.credentials();
    const { clientIdentifier } = await this.options.storage.state();
    const available = await (await this.plexTv()).servers(credentials.accountToken);
    const tokens = { ...credentials.serverTokens };
    const results = await Promise.all(ids.map(async (id) => {
      const server = available.find((s) => s.id === id);
      if (!server) {
        return { id, name: id, error: 'This server is no longer on your Plex account.' };
      }
      const token = server.accessToken ?? credentials.accountToken;
      const url = await PlexServer.findWorkingUrl(connectionCandidates(server), { token, clientIdentifier, machineIdentifier: server.id });
      if (!url) {
        return { id, name: server.name, error: `Cannot reach ${server.name} from Homebridge.` };
      }
      try {
        // Confirms the token works on this server, not just that it answers.
        await new PlexServer({ baseUrl: url, token, clientIdentifier }).libraries();
      } catch (error) {
        return { id, name: server.name, error: describe(error) };
      }
      if (server.accessToken) {
        tokens[server.id] = server.accessToken;
      }
      return { id: server.id, name: server.name, url };
    }));
    await this.options.storage.writeCredentials({ ...credentials, serverTokens: tokens });
    return {
      servers: results.flatMap((r) => ('url' in r && r.url ? [{ id: r.id, name: r.name, url: r.url }] : [])),
      failed: results.flatMap((r) => ('error' in r && r.error ? [{ id: r.id, name: r.name, error: r.error }] : [])),
    };
  }

  async discover(servers: readonly ServerRef[]): Promise<Discovery> {
    if (servers.length === 0) {
      throw new SetupError('Choose a server first.');
    }
    const credentials = await this.credentials();
    const targets = await Promise.all(servers.map(async (ref) => ({ id: ref.id, name: ref.name, server: await this.serverFor(ref, credentials) })));
    return discover(targets, await this.plexTv(), credentials.accountToken);
  }

  /** The address Plex should post webhooks to: an IPv4 address on the same network as the server. */
  async webhookUrl(options: WebhookOptions): Promise<string | undefined> {
    const { webhookSecret } = await this.options.storage.state();
    if (options.advertisedUrl) {
      return `${options.advertisedUrl.replace(/\/+$/, '')}/${webhookSecret}`;
    }
    const address = lanAddress(this.options.networkInterfaces(), options.servers.map((s) => s.url));
    return address ? `http://${address}:${options.port ?? DEFAULT_WEBHOOK_PORT}/${webhookSecret}` : undefined;
  }

  async webhookStatus(options: WebhookOptions): Promise<WebhookStatus> {
    const credentials = await this.credentials();
    const plexTv = await this.plexTv();
    const user = await plexTv.user(credentials.accountToken);
    const url = await this.webhookUrl(options);
    const port = options.port ?? DEFAULT_WEBHOOK_PORT;
    const { webhookSecret } = await this.options.storage.state();
    const [portState, serverSettings] = await Promise.all([
      this.portState(port, webhookSecret),
      Promise.all(options.servers.map(async (ref) => {
        const prefs = await (await this.serverFor(ref, credentials)).prefs().catch((): PlexServerPrefs => ({}));
        return { name: ref.name, enabled: prefs.webhooksEnabled };
      })),
    ]);
    if (!user.plexPass) {
      return { plexPass: false, port, portState, serverSettings, url, registered: false, stale: [], others: [], disabledOn: [] };
    }
    const current = await plexTv.webhooks(credentials.accountToken);
    const ours = (candidate: string) => pathOf(candidate) === `/${webhookSecret}`;
    const disabledOn = serverSettings.filter((s) => s.enabled === false).map((s) => s.name);
    return {
      plexPass: true,
      port,
      portState,
      serverSettings,
      url,
      registered: url !== undefined && current.includes(url),
      stale: current.filter((candidate) => ours(candidate) && candidate !== url),
      others: current.filter((candidate) => !ours(candidate)),
      disabledOn,
    };
  }

  /**
   * Changes the account's webhooks: optionally adds Intermission's (replacing any Intermission
   * address left from an old IP or port) and removes the listed URLs. Every other webhook is kept.
   * Turns on the servers' Webhooks setting when adding. Re-reads the list afterwards, so the page
   * shows what Plex actually has.
   */
  async updateWebhooks(options: WebhookOptions, change: { add: boolean; remove?: readonly string[] }): Promise<WebhookStatus> {
    const before = await this.webhookStatus(options);
    if (!before.plexPass) {
      throw new SetupError('Webhooks need Plex Pass on this account.');
    }
    if (change.add && !before.url) {
      throw new SetupError('Could not work out this Homebridge\'s network address. Set it in Settings, Webhook options.');
    }
    const remove = new Set(change.remove ?? []);
    const keep = before.others.filter((url) => !remove.has(url));
    const wanted = change.add && before.url ? [...keep, before.url] : keep;
    const current = [...before.others, ...before.stale, ...(before.registered && before.url ? [before.url] : [])];
    const credentials = await this.credentials();
    if (wanted.length !== current.length || wanted.some((url) => !current.includes(url))) {
      await (await this.plexTv()).setWebhooks(credentials.accountToken, wanted);
    }
    if (change.add) {
      await Promise.all(options.servers.filter((s) => before.disabledOn.includes(s.name))
        .map(async (ref) => (await this.serverFor(ref, credentials)).setPref('WebHooksEnabled', true)));
    }
    const after = await this.webhookStatus(options);
    if (keep.some((url) => !after.others.includes(url))) {
      // Never drop a webhook the user kept: write the full list once more.
      await (await this.plexTv()).setWebhooks(credentials.accountToken, wanted);
      return this.webhookStatus(options);
    }
    return after;
  }

  async removeWebhook(options: WebhookOptions): Promise<WebhookStatus> {
    const before = await this.webhookStatus(options);
    const after = await this.updateWebhooks(options, { add: false, remove: [...before.stale, ...(before.url ? [before.url] : [])] });
    if (after.registered || after.stale.length > 0) {
      throw new SetupError('Plex kept the Intermission webhook. Try again, or remove it in Plex: Settings, Webhooks.', 502);
    }
    return after;
  }

  /**
   * Checks the webhook port on this machine. Intermission's receiver answers a GET on its secret
   * path, so it can be told apart from another app on the same port.
   */
  private async portState(port: number, secret: string): Promise<PortState> {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/${secret}`, { signal: AbortSignal.timeout(1500) });
      const text = await response.text();
      return response.ok && text.includes('"intermission"') ? 'intermission' : 'other';
    } catch (error) {
      const code = (error as { cause?: { code?: string } }).cause?.code;
      return code === 'ECONNREFUSED' ? 'free' : 'unknown';
    }
  }

  /** Version and project links for the page footer, from package.json. */
  async about(): Promise<{ version: string; node: string; repo: string; issues: string; funding: string }> {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string; repository?: string | { url?: string }; bugs?: string | { url?: string }; funding?: string | { url?: string };
    };
    const clean = (url: unknown) => String(url ?? '').replace(/^git\+/, '').replace(/\.git$/, '');
    const repo = clean(typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url);
    return {
      version: pkg.version ?? '?',
      node: process.version,
      repo,
      issues: clean(typeof pkg.bugs === 'string' ? pkg.bugs : pkg.bugs?.url) || (repo ? `${repo}/issues` : ''),
      funding: clean(typeof pkg.funding === 'string' ? pkg.funding : pkg.funding?.url),
    };
  }
}

export function webhookOptionsFrom(config: Record<string, unknown>): Omit<WebhookOptions, 'servers'> {
  const webhook = (config.webhook && typeof config.webhook === 'object' ? config.webhook : {}) as { port?: unknown; advertisedUrl?: unknown };
  return {
    port: typeof webhook.port === 'number' ? webhook.port : undefined,
    advertisedUrl: typeof webhook.advertisedUrl === 'string' && webhook.advertisedUrl ? webhook.advertisedUrl : undefined,
  };
}

function pathOf(url: string): string | undefined {
  try {
    return new URL(url).pathname.replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

