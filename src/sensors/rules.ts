import type { SensorFilters, StateCondition } from '../config.js';
import type { MediaInfo, PlayerSnapshot, SessionInfo } from '../engine/types.js';

/** What an event or session offers to match against. Missing fields fail any filter on them. */
export interface MatchContext {
  playerId?: string;
  user?: string;
  media?: MediaInfo;
}

export function contextOf(session: SessionInfo | undefined, media?: MediaInfo): MatchContext {
  return { playerId: session?.playerId, user: session?.user, media: session?.media ?? media };
}

/** An empty filter allows everything; a non-empty one must contain the value. */
export function matchesFilters(filters: SensorFilters, context: MatchContext): boolean {
  const allows = (values: readonly string[], actual: string | undefined) =>
    values.length === 0 || (actual !== undefined && values.includes(actual));
  return allows(filters.players, context.playerId)
    && allows(filters.users, context.user)
    && allows(filters.libraries, context.media?.librarySectionId)
    && allows(filters.mediaTypes, context.media?.type);
}

export function stateHolds(condition: StateCondition, snapshot: PlayerSnapshot): boolean {
  switch (condition) {
    case 'playing':
      return snapshot.activity === 'playing' && !snapshot.inCredits;
    case 'playing-any':
      return snapshot.activity === 'playing';
    case 'paused':
      return snapshot.activity === 'paused';
    case 'credits':
      return snapshot.activity !== 'idle' && snapshot.inCredits;
    case 'active':
      return snapshot.activity !== 'idle';
  }
}
