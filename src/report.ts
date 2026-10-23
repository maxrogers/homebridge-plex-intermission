import { readFile } from 'node:fs/promises';

import { commandLine, person, player, readDiagnostics, redact, scrubSecrets, tailDiagnostics } from './diagnostics.js';
import { hidePublicAddresses, maskAddress } from './network.js';
import type { PortState, ReportInput, SetupService } from './setup-service.js';
import { webhookOptionsFrom } from './setup-service.js';

const PORT_STATES: Record<PortState, string> = {
  intermission: 'Intermission is listening',
  free: 'nothing listening (restart Homebridge after saving)',
  other: 'used by another app',
  unknown: 'could not check',
};

/** Plex's "Generate credits video markers" setting, in older numeric and newer named forms. */
const CREDITS_DETECTION: Record<string, string> = {
  0: 'never',
  1: 'as a scheduled task',
  2: 'as a scheduled task and when media is added',
  never: 'never',
  scheduled: 'as a scheduled task',
  asap: 'as a scheduled task and when media is added',
};

async function packageVersion(): Promise<string> {
  return readFile(new URL('../package.json', import.meta.url), 'utf8')
    .then((text) => (JSON.parse(text) as { version?: string }).version ?? '?', () => '?');
}

/**
 * The setup part of a report: versions, account, each server's relevant settings, webhook and
 * bridge. Private values are wrapped for redaction; no tokens or webhook key.
 */
export async function setupReport(service: SetupService, input: ReportInput): Promise<string> {
  const lines = [`Intermission ${await packageVersion()}`, `Homebridge UI ${input.homebridgeVersion ?? '?'}, Node.js ${input.nodeVersion ?? '?'}`];
  if (input.timeZone) {
    lines.push(`Time zone: ${input.timeZone} (log times are UTC)`);
  }
  const runtime = await service.runtime(input.config);
  lines.push(`Running: ${!runtime.running ? 'not started since setup (restart Homebridge)' : `since ${runtime.startedAt}${runtime.current ? '' : ', with older settings (a restart is pending)'}`}`, '');

  const credentials = await service.storage.readCredentials();
  const status = await service.status(typeof input.config.setupId === 'string' ? input.config.setupId : undefined);
  lines.push(`Plex account: ${status.signedIn ? (status.username ? person(status.username) : 'signed in') : 'not signed in'}`);
  lines.push(`Plex Pass: ${status.plexPass === undefined ? 'unknown' : status.plexPass ? 'yes' : 'no'}`);

  for (const ref of input.servers) {
    lines.push('', `Server: ${ref.name} (${maskAddress(ref.url)})`);
    if (!credentials) {
      continue;
    }
    const server = await service.serverFor(ref, credentials);
    const [identity, prefs, libraries] = await Promise.all([
      server.identity().catch(() => undefined),
      server.prefs().catch(() => undefined),
      server.libraries().catch(() => undefined),
    ]);
    lines.push(`  Version: ${identity?.version || 'unreachable'}`);
    if (prefs) {
      lines.push(`  Credits detection: ${CREDITS_DETECTION[prefs.creditsDetection ?? ''] ?? prefs.creditsDetection ?? 'unknown'}`);
      lines.push(`  Webhooks setting: ${prefs.webhooksEnabled === undefined ? 'unknown' : prefs.webhooksEnabled ? 'on' : 'off'}`);
      if (prefs.playedThreshold !== undefined) {
        lines.push(`  Marked watched at: ${prefs.playedThreshold}%`);
      }
    } else {
      lines.push('  Server settings: not readable with this sign-in');
    }
    for (const library of libraries ?? []) {
      lines.push(`  Library ${library.id}: ${library.title} (${library.type}${library.agent ? `, ${library.agent}` : ''})`);
    }
  }

  if (status.signedIn && status.plexPass) {
    const webhook = await service.webhookStatus({ ...webhookOptionsFrom(input.config), servers: input.servers }).catch(() => undefined);
    lines.push('', `Webhook: ${webhook ? (webhook.registered ? 'registered' : 'not registered') : 'unknown'}${webhook?.stale.length ? ' (an old address is also registered)' : ''}`);
    lines.push(`Other webhooks on the account: ${webhook?.others.length ?? '?'}`);
    if (webhook) {
      lines.push(`Webhook port ${webhook.port}: ${PORT_STATES[webhook.portState]}`);
    }
  }

  const sensors = Array.isArray(input.config.sensors) ? input.config.sensors as { name?: string; type?: string; state?: string; events?: string[] }[] : [];
  lines.push('', `Sensors: ${sensors.length}`);
  for (const sensor of sensors) {
    lines.push(`  ${sensor.name ?? '?'}: ${sensor.type ?? '?'} ${sensor.state ?? (sensor.events ?? []).join(', ')}`);
  }
  const bridge = input.config._bridge as { username?: string; port?: number } | undefined;
  const pairing = bridge?.username ? await service.bridgePairing(bridge.username).catch(() => undefined) : undefined;
  const paired = pairing ? (pairing.paired ? ', added to the Home app' : pairing.published ? ', not added to the Home app yet' : ', not started yet') : '';
  lines.push('', `Bridge: ${bridge?.username ? `own child bridge (port ${bridge.port ?? 'automatic'})${paired}` : 'main Homebridge bridge'}`);
  lines.push(`Settings: ${JSON.stringify({ timing: input.config.timing ?? {}, webhook: input.config.webhook ?? {}, detailedLogging: input.config.detailedLogging ?? false })}`);
  return lines.join('\n');
}

/**
 * Everything needed to look into a problem, as one text file: the setup report, every sensor, and
 * the recent log the plugin keeps. Never contains the Plex sign-in, server tokens or the webhook
 * key; public addresses are hidden; titles, people, players and command lines are replaced with
 * placeholders unless `includeNames` is set.
 */
export async function diagnosticsReport(service: SetupService, input: ReportInput & { includeNames?: boolean }, now: Date): Promise<string> {
  const config = input.config;
  const selection = (config.selection ?? {}) as { players?: { id: string; name?: string; product?: string }[]; libraries?: { key: string; title?: string }[] };
  const players = new Map((selection.players ?? []).map((p) => [p.id, p]));
  // The app and the start of the ID tell apart players with the same name.
  const describePlayer = (id: string) => {
    const found = players.get(id);
    const tell = [found?.product, id.slice(0, 8)].filter(Boolean).join(', ');
    return found?.name ? `${player(found.name)} (${tell})` : id;
  };
  const libraryNames = new Map((selection.libraries ?? []).map((l) => [l.key, l.title ?? l.key]));
  const commands = new Map(((config.commands as { list?: { id: string; name?: string; command?: string }[] } | undefined)?.list ?? []).map((c) => [c.id, c]));
  const list = (values: unknown, name: (v: string) => string, all: string) => {
    const items = Array.isArray(values) ? values.map(String) : [];
    return items.length === 0 ? all : items.map(name).join(', ');
  };

  const lines = [
    'Intermission diagnostics',
    `Created ${now.toISOString()}. ${input.includeNames ? 'Titles and names are included.' : 'Titles, people, players and command lines are replaced with placeholders.'}`,
    'Never includes your Plex sign-in, server tokens or webhook key. Public addresses are hidden.',
    '', '== Setup ==', await setupReport(service, input),
    '', '== Sensors ==',
  ];
  const sensors = Array.isArray(config.sensors) ? config.sensors as Record<string, unknown>[] : [];
  for (const sensor of sensors) {
    const f = (sensor.filters ?? {}) as Record<string, unknown>;
    const run = (sensor.run ?? {}) as Record<string, string[]>;
    const ran = ['on', 'off', 'press'].flatMap((key) => (run[key]?.length ? [`${key}: ${run[key].map((id) => commands.get(id)?.name ?? id).join(', ')}`] : []));
    lines.push(`${String(sensor.name)} [${String(sensor.type)}${sensor.group ? `, ${String(sensor.group).split(':')[0]} preset` : ''}]`);
    lines.push(sensor.type === 'button'
      ? `  pressed on: ${list(sensor.events, (e) => e, 'nothing')}`
      : `  on while: ${String(sensor.state)}${Array.isArray(sensor.except) && sensor.except.length ? `, except ${sensor.except.join(' and ')}` : ''}`);
    lines.push(`  players: ${list(f.players, describePlayer, 'all')}`);
    lines.push(`  people: ${list(f.users, (u) => person(u), 'all')}`);
    lines.push(`  libraries: ${list(f.libraries, (k) => libraryNames.get(k) ?? k, 'all')}`);
    if (sensor.media && Object.keys(sensor.media).length) {
      lines.push(`  media conditions: ${JSON.stringify(sensor.media)}`);
    }
    if (ran.length) {
      lines.push(`  commands: ${ran.join('; ')}`);
    }
  }
  if (commands.size > 0) {
    lines.push('', `== Commands (${(config.commands as { enabled?: boolean }).enabled ? 'on' : 'off'}) ==`);
    for (const command of commands.values()) {
      lines.push(`${command.name ?? '?'}: ${commandLine(command.command ?? '')}`);
    }
  }
  const log = (await readDiagnostics(service.storage.directory)).reverse();
  lines.push('', `== Recent log (${log.length} lines, newest first, detailed) ==`, ...(log.length ? log : [NOTHING_LOGGED]));
  return hidePublicAddresses(scrubSecrets(redact(lines.join('\n'), input.includeNames === true), await secretsOf(service)));
}

const NOTHING_LOGGED = 'Nothing logged yet. Restart Homebridge once, so Intermission starts keeping its log.';

/**
 * The newest lines of the kept log, newest first, for watching on the settings page. Shown only on
 * this machine, so names are kept; secrets are still removed.
 */
export async function liveLog(service: SetupService, maxLines = 200): Promise<string[]> {
  const log = (await tailDiagnostics(service.storage.directory, maxLines)).reverse();
  if (log.length === 0) {
    return [NOTHING_LOGGED];
  }
  return scrubSecrets(redact(log.join('\n'), true), await secretsOf(service)).split('\n');
}

async function secretsOf(service: SetupService): Promise<string[]> {
  const credentials = await service.storage.readCredentials();
  const { webhookSecret } = await service.storage.state();
  return [webhookSecret, credentials?.accountToken, ...Object.values(credentials?.serverTokens ?? {})].filter((s): s is string => Boolean(s));
}
