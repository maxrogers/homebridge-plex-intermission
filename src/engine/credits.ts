import type { EngineSettings, Marker } from './types.js';

/**
 * Position at which the credits begin, from Plex's credits markers or the percentage fallback.
 * Returns null when neither applies.
 */
export function creditsStart(
  markers: readonly Marker[],
  durationMs: number | undefined,
  settings: Pick<EngineSettings, 'useFirstCreditsMarker' | 'fallbackPercent'>,
): number | null {
  const credits = markers.filter((marker) => marker.type === 'credits');
  if (credits.length > 0) {
    const starts = credits.map((marker) => marker.startMs);
    if (settings.useFirstCreditsMarker) {
      return Math.min(...starts);
    }
    return credits.find((marker) => marker.final)?.startMs ?? Math.max(...starts);
  }
  if (settings.fallbackPercent !== null && durationMs) {
    return Math.round((durationMs * settings.fallbackPercent) / 100);
  }
  return null;
}
