import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { Logger } from './engine/types.js';

/*
 * Private values (titles, people, players, command lines) are wrapped in invisible markers when
 * logged. Homebridge's log shows them as plain text; the diagnostics file keeps the markers, so a
 * shared copy can replace them with placeholders such as "Title 1".
 */
const MARK = '⁣';
type PrivateKind = 'title' | 'person' | 'player' | 'command';

function privateValue(kind: PrivateKind, value: string | undefined): string {
  return value === undefined || value === '' ? '' : `${MARK}${kind}:${value}${MARK}`;
}
export const title = (value?: string) => privateValue('title', value);
export const person = (value?: string) => privateValue('person', value);
export const player = (value?: string) => privateValue('player', value);
export const commandLine = (value?: string) => privateValue('command', value);

const MARKED = new RegExp(`${MARK}(title|person|player|command):([^${MARK}]*)${MARK}`, 'g');

/** Plain text, as Homebridge's log shows it. */
export function unmark(text: string): string {
  return text.replace(MARKED, (_, _kind: string, value: string) => value);
}

const PLACEHOLDER: Record<PrivateKind, string> = { title: 'Title', person: 'Person', player: 'Player', command: 'Command' };

/**
 * Replaces private values with numbered placeholders, the same value getting the same number, or
 * keeps them when `includeNames` is set. Command lines are always hidden unless names are included,
 * since they may hold addresses or keys.
 */
export function redact(text: string, includeNames: boolean): string {
  const numbers = new Map<string, number>();
  const counts = new Map<string, number>();
  return text.replace(MARKED, (_, kind: PrivateKind, value: string) => {
    if (includeNames) {
      return value;
    }
    if (kind === 'command') {
      return '(command line hidden)';
    }
    const key = `${kind}:${value}`;
    let number = numbers.get(key);
    if (number === undefined) {
      number = (counts.get(kind) ?? 0) + 1;
      counts.set(kind, number);
      numbers.set(key, number);
    }
    return `${PLACEHOLDER[kind]} ${number}`;
  });
}

/** Tokens, secrets and keys that must never leave the machine, whatever was logged. */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let result = text.replace(/(X-Plex-Token[=:]\s*)[A-Za-z0-9_-]+/gi, '$1(hidden)');
  for (const secret of secrets) {
    if (secret.length >= 8) {
      result = result.split(secret).join('(key)');
    }
  }
  return result;
}

function format(message: string, parameters: unknown[]): string {
  let index = 0;
  return message.replace(/%[sdj%]/g, (token) => {
    if (token === '%%') {
      return '%';
    }
    const value = parameters[index++];
    if (token === '%j') {
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }
    return String(value);
  }) + (index < parameters.length ? ` ${parameters.slice(index).map(String).join(' ')}` : '');
}

const DIAGNOSTICS_FILE = 'diagnostics.log';
const PREVIOUS_FILE = 'diagnostics.1.log';

/**
 * Keeps the recent detailed log in the plugin's storage folder, whatever the logging setting, so a
 * problem can be reported without turning on detailed logging and making it happen again. Two files
 * of at most `maxBytes` each; writes are batched and never block or fail the plugin.
 */
export class DiagnosticLog {
  private buffer: string[] = [];
  private timer?: NodeJS.Timeout;
  private writing = Promise.resolve();

  constructor(
    private readonly directory: string,
    private readonly maxBytes = 1_000_000,
    private readonly flushMs = 2_000,
    private readonly now = () => new Date(),
  ) {}

  add(level: string, message: string, parameters: unknown[]): void {
    this.buffer.push(`${this.now().toISOString()} ${level.padEnd(5)} ${format(message, parameters)}`);
    this.timer ??= setTimeout(() => void this.flush(), this.flushMs);
    this.timer.unref?.();
  }

  /** Writes what is buffered. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const lines = this.buffer;
    this.buffer = [];
    if (lines.length === 0) {
      return this.writing;
    }
    this.writing = this.writing.then(async () => {
      const file = join(this.directory, DIAGNOSTICS_FILE);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const size = await stat(file).then((s) => s.size, () => 0);
      if (size > this.maxBytes) {
        await rename(file, join(this.directory, PREVIOUS_FILE));
      }
      await appendFile(file, `${lines.join('\n')}\n`, { mode: 0o600 });
    }).catch(() => undefined);
    return this.writing;
  }

  /** Wraps a logger so everything, debug included, is also kept here. */
  wrap(log: Logger): Logger {
    return {
      debug: (message, ...parameters) => {
        this.add('debug', message, parameters);
        log.debug(unmark(message), ...parameters.map(unmarkValue));
      },
      info: (message, ...parameters) => {
        this.add('info', message, parameters);
        log.info(unmark(message), ...parameters.map(unmarkValue));
      },
      warn: (message, ...parameters) => {
        this.add('warn', message, parameters);
        log.warn(unmark(message), ...parameters.map(unmarkValue));
      },
      error: (message, ...parameters) => {
        this.add('error', message, parameters);
        log.error(unmark(message), ...parameters.map(unmarkValue));
      },
    };
  }
}

const unmarkValue = (value: unknown) => (typeof value === 'string' ? unmark(value) : value);

/** The last `maxLines` lines of the kept log, oldest first. */
export async function readDiagnostics(directory: string, maxLines = 6_000): Promise<string[]> {
  const read = (name: string) => readFile(join(directory, name), 'utf8').then((text) => text.split('\n').filter(Boolean), () => [] as string[]);
  const lines = [...await read(PREVIOUS_FILE), ...await read(DIAGNOSTICS_FILE)];
  return lines.slice(-maxLines);
}
