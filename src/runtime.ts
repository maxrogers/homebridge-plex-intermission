import { createHash } from 'node:crypto';

/**
 * What the running plugin loaded, so the settings page can tell whether saved settings are in use
 * or still need a Homebridge restart.
 */
export interface RunningRecord {
  /** Fingerprint of the config block the plugin started with. */
  fingerprint: string;
  startedAt: string;
}

/** Sorts keys so the same settings always give the same text. Keys starting with `_` (Homebridge's own, such as `_bridge`) are left out. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stable);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>)
      .filter((key) => !key.startsWith('_') && (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map((key) => [key, stable((value as Record<string, unknown>)[key])]));
  }
  return value;
}

export function configFingerprint(config: unknown): string {
  return createHash('sha256').update(JSON.stringify(stable(config ?? {}))).digest('hex').slice(0, 16);
}
