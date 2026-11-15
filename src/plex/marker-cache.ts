import type { Clock } from '../engine/clock.js';
import type { Marker } from '../engine/types.js';

interface Entry {
  markers: readonly Marker[];
  fetchedAt: number;
}

/** Items kept; the oldest is dropped beyond this. */
const MAX_ENTRIES = 500;

/**
 * Caches credits and intro markers per item. Items without markers are checked again after
 * `emptyTtlMs`, because Plex may generate them later.
 */
export class MarkerCache {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<readonly Marker[]>>();

  constructor(
    private readonly fetchMarkers: (ratingKey: string) => Promise<readonly Marker[]>,
    private readonly clock: Clock,
    private readonly emptyTtlMs = 6 * 60 * 60 * 1000,
  ) {}

  get(ratingKey: string): Promise<readonly Marker[]> {
    const entry = this.entries.get(ratingKey);
    if (entry && (entry.markers.length > 0 || this.clock.now() - entry.fetchedAt < this.emptyTtlMs)) {
      return Promise.resolve(entry.markers);
    }
    let request = this.pending.get(ratingKey);
    if (!request) {
      request = this.fetchMarkers(ratingKey)
        .then((markers) => {
          this.entries.delete(ratingKey);
          this.entries.set(ratingKey, { markers, fetchedAt: this.clock.now() });
          if (this.entries.size > MAX_ENTRIES) {
            this.entries.delete(this.entries.keys().next().value!);
          }
          return markers;
        })
        .finally(() => this.pending.delete(ratingKey));
      this.pending.set(ratingKey, request);
    }
    return request;
  }
}
