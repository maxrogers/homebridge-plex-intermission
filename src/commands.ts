import { spawn } from 'node:child_process';

import type { Logger } from './engine/types.js';

/** A command the user named in Settings. */
export interface NamedCommand {
  id: string;
  name: string;
  command: string;
}

/** Values a command can use as {placeholders}. Every value is quoted for the shell. */
export interface CommandContext {
  sensor?: string;
  /** "on", "off" or "pressed". */
  state?: string;
  /** The engine event behind a button press, for example "credits.start". */
  event?: string;
  title?: string;
  type?: string;
  library?: string;
  player?: string;
  user?: string;
}

export interface CommandResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

const PLACEHOLDER = /\{(sensor|state|event|title|type|library|player|user)\}/g;
const OUTPUT_LIMIT = 4000;

/** Quotes a value so the shell passes it through as one literal argument. */
export function shellQuote(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return `"${value.replace(/"/g, '""').replace(/%/g, '%%')}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Fills in {placeholders}. Values are quoted, so titles with quotes or `;` can't change the command. */
export function expandCommand(command: string, context: CommandContext, platform: NodeJS.Platform = process.platform): string {
  return command.replace(PLACEHOLDER, (_match, key: keyof CommandContext) => shellQuote(context[key] ?? '', platform));
}

/**
 * Runs named commands on the Homebridge machine (inside the container when Homebridge runs in
 * Docker). Each run is independent, limited in time, and logged; failures never affect the sensors.
 */
export class CommandRunner {
  constructor(
    private readonly log: Logger,
    private readonly timeoutMs = 30_000,
  ) {}

  run(command: NamedCommand, context: CommandContext): Promise<CommandResult> {
    const line = expandCommand(command.command, context);
    this.log.debug('Running command "%s": %s', command.name, line);
    return new Promise((resolve) => {
      let output = '';
      let timedOut = false;
      const child = spawn(line, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const collect = (chunk: Buffer) => {
        if (output.length < OUTPUT_LIMIT) {
          output += chunk.toString('utf8').slice(0, OUTPUT_LIMIT - output.length);
        }
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, this.timeoutMs);
      let done = false;
      const finish = (code: number | null) => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        const result = { code, output: output.trim(), timedOut };
        if (timedOut) {
          this.log.warn('Command "%s" took longer than %ds and was stopped.', command.name, Math.round(this.timeoutMs / 1000));
        } else if (code !== 0) {
          this.log.warn('Command "%s" failed (exit %s)%s', command.name, code, result.output ? `: ${result.output.slice(0, 300)}` : '');
        } else {
          this.log.info('Ran command "%s"', command.name);
        }
        resolve(result);
      };
      child.on('error', (error) => {
        output += error.message;
        finish(null);
      });
      child.on('close', (code) => finish(code));
    });
  }
}
