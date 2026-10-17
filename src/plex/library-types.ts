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
  private reading?: Promise<void>;

  constructor(private readonly sources: { serverId: string; libraries(): Promise<PlexLibrary[]> }[]) {}

  refresh(): Promise<void> {
    this.reading ??= Promise.all(this.sources.map(async (source) => {
      const libraries = await source.libraries().catch(() => undefined);
      for (const library of libraries ?? []) {
        const key = `${source.serverId}/${library.id}`;
        this.known.add(key);
        if (libraryKind(library) === 'other') {
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

  async hasCredits(serverId: string, media: { type: string; librarySectionId?: string }): Promise<boolean> {
    if (!CREDITED_TYPES.has(media.type)) {
      return false;
    }
    const key = `${serverId}/${media.librarySectionId}`;
    if (media.librarySectionId !== undefined && !this.known.has(key)) {
      await this.refresh();
    }
    return !this.personal.has(key);
  }
}
