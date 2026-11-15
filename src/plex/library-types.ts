import { CREDITED_TYPES } from '../engine/credits.js';
import { libraryKind } from './discovery.js';
import type { PlexLibrary } from './server.js';

/**
 * Knows which libraries can have credits. "Other Videos" libraries hold movies to Plex but have no
 * credits. An item from a library not seen yet triggers a fresh read, so libraries added later are
 * handled correctly at once, including by sensors set to "All libraries".
 */
export class LibraryTypes {
  private readonly personal = new Set<string>();
  private readonly known = new Set<string>();
  /** Movie, TV and Other Videos libraries, whose trailers and extras count for them. */
  private readonly video = new Set<string>();
  private reading?: Promise<void>;

  constructor(private readonly sources: { serverId: string; libraries(): Promise<PlexLibrary[]> }[]) {}

  refresh(): Promise<void> {
    this.reading ??= Promise.all(this.sources.map(async (source) => {
      const libraries = await source.libraries().catch(() => undefined);
      for (const library of libraries ?? []) {
        const key = `${source.serverId}/${library.id}`;
        this.known.add(key);
        const kind = libraryKind(library);
        if (kind === 'movie' || kind === 'show' || kind === 'other') {
          this.video.add(key);
        } else {
          this.video.delete(key);
        }
        if (kind === 'other') {
          this.personal.add(key);
        } else {
          this.personal.delete(key);
        }
      }
    })).then(() => {
      this.reading = undefined;
    });
    return this.reading;
  }

  /** Whether a library (`serverId/sectionId`) holds video, so trailers and extras count for it. */
  isVideo(key: string): boolean {
    return this.video.has(key);
  }

  async hasCredits(serverId: string, media: { type: string; librarySectionId?: string; live?: boolean }): Promise<boolean> {
    // Live TV: Plex only knows the scheduled length, so a percentage would land mid-broadcast.
    if (media.live || !CREDITED_TYPES.has(media.type)) {
      return false;
    }
    const key = `${serverId}/${media.librarySectionId}`;
    if (media.librarySectionId !== undefined && !this.known.has(key)) {
      await this.refresh();
    }
    return !this.personal.has(key);
  }
}
