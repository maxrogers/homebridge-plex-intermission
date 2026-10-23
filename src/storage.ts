import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { RunningRecord } from './runtime.js';

export interface Credentials {
  /** plex.tv account token, used for plex.tv requests. */
  accountToken: string;
  /** Access tokens per server, when they differ from the account token (servers shared with you). */
  serverTokens?: Record<string, string>;
  username?: string;
  savedAt: string;
  /**
   * Matches `setupId` in the plugin's config. Homebridge keeps a plugin's storage folder when the
   * plugin is removed, so credentials without a matching config are left over and are ignored.
   */
  setupId?: string;
}

/** Values that must stay the same across restarts: Plex's client ID for this install, and the webhook key. */
export interface PluginState {
  clientIdentifier: string;
  webhookSecret: string;
}

/** The last Plex Pass status seen, and whether the settings page has shown the latest change. */
export interface PlexPassRecord {
  active: boolean;
  /** When the status last changed (ISO date). */
  changedAt: string;
  acknowledged: boolean;
}

/** The token to use for a server. */
export function serverToken(credentials: Credentials, serverId: string): string {
  return credentials.serverTokens?.[serverId] ?? credentials.accountToken;
}

const FILES = {
  credentials: 'credentials.json',
  state: 'state.json',
  plexPass: 'plex-pass.json',
  running: 'running.json',
} as const;

/**
 * Files in `<Homebridge storage>/intermission`. The folder is owner-only (0700) and every file is
 * written atomically as owner-only (0600). Credentials never leave this module except to make
 * Plex requests, and are never logged.
 */
export class Storage {
  readonly directory: string;

  constructor(homebridgeStoragePath: string) {
    this.directory = join(homebridgeStoragePath, 'intermission');
  }

  async readCredentials(): Promise<Credentials | undefined> {
    const value = await this.readJson(FILES.credentials);
    return value && typeof value.accountToken === 'string' && value.accountToken ? value as unknown as Credentials : undefined;
  }

  writeCredentials(credentials: Credentials): Promise<void> {
    return this.writeJson(FILES.credentials, credentials);
  }

  deleteCredentials(): Promise<void> {
    return rm(this.path(FILES.credentials), { force: true });
  }

  /** Reads the plugin state, creating it on first use. */
  async state(): Promise<PluginState> {
    const value = await this.readJson(FILES.state);
    if (value && typeof value.clientIdentifier === 'string' && typeof value.webhookSecret === 'string') {
      return { clientIdentifier: value.clientIdentifier, webhookSecret: value.webhookSecret };
    }
    const state: PluginState = {
      clientIdentifier: `homebridge-intermission-${randomUUID()}`,
      webhookSecret: randomBytes(16).toString('hex'),
    };
    await this.writeJson(FILES.state, state);
    return state;
  }

  /**
   * Records the Plex Pass status. The first record is silent; a later change stays unacknowledged
   * until the settings page shows it.
   */
  async recordPlexPass(active: boolean, now = new Date()): Promise<PlexPassRecord> {
    const previous = await this.readPlexPass();
    if (previous && previous.active === active) {
      return previous;
    }
    const record: PlexPassRecord = { active, changedAt: now.toISOString(), acknowledged: previous === undefined };
    await this.writeJson(FILES.plexPass, record);
    return record;
  }

  async readPlexPass(): Promise<PlexPassRecord | undefined> {
    const value = await this.readJson(FILES.plexPass);
    return value && typeof value.active === 'boolean' && typeof value.changedAt === 'string'
      ? { active: value.active, changedAt: value.changedAt, acknowledged: value.acknowledged !== false }
      : undefined;
  }

  async acknowledgePlexPass(): Promise<void> {
    const record = await this.readPlexPass();
    if (record && !record.acknowledged) {
      await this.writeJson(FILES.plexPass, { ...record, acknowledged: true });
    }
  }

  /** Written by the plugin at start; read by the settings page. */
  writeRunning(record: RunningRecord): Promise<void> {
    return this.writeJson(FILES.running, record);
  }

  async readRunning(): Promise<RunningRecord | undefined> {
    const value = await this.readJson(FILES.running);
    return value && typeof value.fingerprint === 'string' && typeof value.startedAt === 'string'
      ? { fingerprint: value.fingerprint, startedAt: value.startedAt }
      : undefined;
  }

  /** Removes the sign-in and Plex Pass history. Keeps the client ID and webhook key. */
  async reset(): Promise<void> {
    await rm(this.path(FILES.credentials), { force: true });
    await rm(this.path(FILES.plexPass), { force: true });
  }

  private path(name: string): string {
    return join(this.directory, name);
  }

  private async readJson(name: string): Promise<Record<string, unknown> | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path(name), 'utf8'));
      return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
    } catch {
      return undefined;
    }
  }

  private async writeJson(name: string, value: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const file = this.path(name);
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
    await chmod(file, 0o600);
  }
}
