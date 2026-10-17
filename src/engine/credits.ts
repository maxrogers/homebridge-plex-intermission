import type { EngineSettings, Marker } from './types.js';

/** Media types that have credits. The percentage fallback never applies to music, photos or clips. */
export const CREDITED_TYPES: ReadonlySet<string> = new Set(['movie', 'episode']);

/**
 * How mid-credits scenes are handled:
 * - `scenes`: credits follow every credits marker, so a scene between two markers counts as playing;
 * - `first`: credits run from the first credits marker to the end;
 * - `final`: credits run from the final credits marker to the end.
 */
export type CreditsMode = 'scenes' | 'first' | 'final';

/** A stretch of credits. `endMs` is Infinity for the last one, which runs to the end. */
export interface CreditsRange {
  startMs: number;
  endMs: number;
}

/** Gaps shorter than this between two credits markers are not treated as a scene. */
const MIN_SCENE_MS = 10_000;

/**
 * Where the credits are, from Plex's credits markers or the percentage fallback.
 * Returns an empty list when neither applies.
 */
export function creditsRanges(
  markers: readonly Marker[],
  durationMs: number | undefined,
  settings: Pick<EngineSettings, 'creditsMode' | 'fallbackPercent'>,
  mediaType = 'movie',
): CreditsRange[] {
  const credits = markers.filter((marker) => marker.type === 'credits').sort((a, b) => a.startMs - b.startMs);
  if (credits.length > 0) {
    if (settings.creditsMode === 'first') {
      return [{ startMs: credits[0]!.startMs, endMs: Infinity }];
    }
    if (settings.creditsMode === 'final') {
      const final = credits.find((marker) => marker.final) ?? credits[credits.length - 1]!;
      return [{ startMs: final.startMs, endMs: Infinity }];
    }
    const ranges: CreditsRange[] = [];
    for (const marker of credits) {
      const last = ranges[ranges.length - 1];
      if (last && marker.startMs - last.endMs < MIN_SCENE_MS) {
        last.endMs = Math.max(last.endMs, marker.endMs);
      } else {
        ranges.push({ startMs: marker.startMs, endMs: Math.max(marker.endMs, marker.startMs) });
      }
    }
    ranges[ranges.length - 1]!.endMs = Infinity;
    return ranges;
  }
  if (settings.fallbackPercent !== null && durationMs && CREDITED_TYPES.has(mediaType)) {
    return [{ startMs: Math.round((durationMs * settings.fallbackPercent) / 100), endMs: Infinity }];
  }
  return [];
}

/** Position at which the credits first begin, or null. */
export function creditsStart(...args: Parameters<typeof creditsRanges>): number | null {
  return creditsRanges(...args)[0]?.startMs ?? null;
}
