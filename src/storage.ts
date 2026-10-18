import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { RunningRecord } from './runtime.js';

export interface Credentials {
  /** plex.tv account token, used for plex.tv requests. */
  accountToken: string;
  /** Access tokens per server, when they differ from the account token. */
  serverTokens?: Record<string, string>;
  /** Older single-server token. */
  serverToken?: string;
  username?: string;
  savedAt: string;
  /**
   * Matches `setupId` in the plugin's config. Homebridge keeps a plugin's storage folder when the
   * plugin is removed, so credentials without a matching config are left over and are ignored.
   */
  setupId?: string;
}

/** Non-secret values that must stay stable across restarts. */
export interface PluginState {
  clientIdentifier: string;
  webhookSecret: string;
}

/**
 * Files in `<Homebridge storage>/intermission`. Credentials are written atomically with owner-only
 * permissions and never leave this module except to make Plex requests.
 */
/** The last Plex Pass status seen, and whether the user has seen the latest change. */
export interface PlexPassRecord {
  active: boolean;
  /** When the status last changed (ISO date). */
  changedAt: string;
  /** False until the settings page has shown the change. */
  acknowledged: boolean;
}

/** The token to use for a server. */
export function serverToken(credentials: Credentials, serverId: string): string {
  return credentials.serverTokens?.[serverId] ?? credentials.serverToken ?? credentials.accountToken;
}

export class Storage {
  readonly directory: string;

  constructor(homebridgeStoragePath: string) {
    this.directory = join(homebridgeStoragePath, 'intermission');
  }

  private get credentialsFile(): string {
    return join(this.directory, 'credentials.json');
  }

  private get plexPassFile(): string {
    return join(this.directory, 'plex-pass.json');
  }

  /**
   * Records the Plex Pass status. The first record is silent; a later change is kept unacknowledged
   * until the settings page shows it. Returns the record.
   */
  async recordPlexPass(active: boolean, now = new Date()): Promise<PlexPassRecord> {
    const previous = await this.readPlexPass();
    if (previous && previous.active === active) {
      return previous;
    }
    const record: PlexPassRecord = { active, changedAt: now.toISOString(), acknowledged: previous === undefined };
    await this.writeJson(this.plexPassFile, record);
    return record;
  }

  async readPlexPass(): Promise<PlexPassRecord | undefined> {
    const value = await this.readJson(this.plexPassFile);
    return value && typeof value.active === 'boolean' && typeof value.changedAt === 'string'
      ? { active: value.active, changedAt: value.changedAt, acknowledged: value.acknowledged !== false }
      : undefined;
  }

  async acknowledgePlexPass(): Promise<void> {
    const record = await this.readPlexPass();
    if (record && !record.acknowledged) {
      await this.writeJson(this.plexPassFile, { ...record, acknowledged: true });
    }
  }

  private get runningFile(): string {
    return join(this.directory, 'running.json');
  }

  /** Written by the plugin at start; read by the settings page. */
  async writeRunning(record: RunningRecord): Promise<void> {
    await this.writeJson(this.runningFile, record);
  }

  async readRunning(): Promise<RunningRecord | undefined> {
    const value = await this.readJson(this.runningFile);
    return value && typeof value.fingerprint === 'string' && typeof value.startedAt === 'string'
      ? { fingerprint: value.fingerprint, startedAt: value.startedAt }
      : undefined;
  }

  /** Removes the sign-in and Plex Pass history. Keeps the client id and webhook key. */
  async reset(): Promise<void> {
    await rm(this.credentialsFile, { force: true });
    await rm(this.plexPassFile, { force: true });
  }

  private get stateFile(): string {
    return join(this.directory, 'state.json');
  }

  async readCredentials(): Promise<Credentials | undefined> {
    const value = await this.readJson(this.credentialsFile);
    if (value && typeof value.accountToken === 'string' && value.accountToken) {
      return value as unknown as Credentials;
    }
    return undefined;
  }

  async writeCredentials(credentials: Credentials): Promise<void> {
    await this.writeJson(this.credentialsFile, credentials);
  }

  async deleteCredentials(): Promise<void> {
    await rm(this.credentialsFile, { force: true });
  }

  /** Reads the plugin state, creating it on first use. */
  async state(): Promise<PluginState> {
    const value = await this.readJson(this.stateFile);
    if (value && typeof value.clientIdentifier === 'string' && typeof value.webhookSecret === 'string') {
      return value as unknown as PluginState;
    }
    const state: PluginState = {
      clientIdentifier: `homebridge-intermission-${randomUUID()}`,
      webhookSecret: randomBytes(16).toString('hex'),
    };
    await this.writeJson(this.stateFile, state);
    return state;
  }

  private async readJson(file: string): Promise<Record<string, unknown> | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(file, 'utf8'));
      return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
    } catch {
      return undefined;
    }
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
    await chmod(file, 0o600);
  }
}
