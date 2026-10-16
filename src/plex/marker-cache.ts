import type { Clock } from '../engine/clock.js';
import type { Marker } from '../engine/types.js';

interface Entry {
  markers: readonly Marker[];
  fetchedAt: number;
}

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
          this.entries.set(ratingKey, { markers, fetchedAt: this.clock.now() });
          return markers;
        })
        .finally(() => this.pending.delete(ratingKey));
      this.pending.set(ratingKey, request);
    }
    return request;
  }

  /** Forgets an item, for example after `library.new` reports it changed. */
  invalidate(ratingKey: string): void {
    this.entries.delete(ratingKey);
  }

  clear(): void {
    this.entries.clear();
  }
}
