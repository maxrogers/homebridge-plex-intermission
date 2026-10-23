import type { Exception, MediaConditions, SensorFilters, StateCondition } from '../config.js';
import { person, player as playerName } from '../diagnostics.js';
import { WIDE_ASPECT, type MediaFacts } from '../plex/media-facts.js';
import type { MediaInfo, PlayerSnapshot, SessionInfo } from '../engine/types.js';

/** What an event or session offers to match against. Missing fields fail any filter on them. */
export interface MatchContext {
  /** The server the event came from. Library filters may name `serverId/sectionId`. */
  serverId?: string;
  playerId?: string;
  user?: string;
  media?: MediaInfo;
}

export function contextOf(session: SessionInfo | undefined, media?: MediaInfo, serverId?: string): MatchContext {
  return { serverId, playerId: session?.playerId, user: session?.user, media: session?.media ?? media };
}

/** An empty filter allows everything; a non-empty one must contain the value. */
export function matchesFilters(filters: SensorFilters, context: MatchContext): boolean {
  const allows = (values: readonly string[], actual: string | undefined) =>
    values.length === 0 || (actual !== undefined && values.includes(actual));
  const section = context.media?.librarySectionId;
  const library = filters.libraries.length === 0 || (section !== undefined
    && (filters.libraries.includes(section) || (context.serverId !== undefined && filters.libraries.includes(`${context.serverId}/${section}`))));
  return allows(filters.players, context.playerId) && allows(filters.users, context.user) && library;
}

export function stateHolds(condition: StateCondition, snapshot: PlayerSnapshot, except: readonly Exception[] = []): boolean {
  const excluded = (except.includes('credits') && snapshot.inCredits) || (except.includes('intro') && snapshot.inIntro);
  switch (condition) {
    case 'playing':
      return snapshot.activity === 'playing' && !excluded;
    case 'paused':
      return snapshot.activity === 'paused' && !excluded;
    case 'active':
      return snapshot.activity !== 'idle' && !excluded;
    case 'credits':
      return snapshot.activity !== 'idle' && snapshot.inCredits;
    case 'intro':
      return snapshot.activity !== 'idle' && snapshot.inIntro;
    case 'idle':
      return snapshot.activity === 'idle';
  }
}

/**
 * Why an item fails a sensor's media conditions, or undefined when it meets them. Unknown facts fail
 * a condition on them, so a sensor with conditions stays off for media Plex can't describe.
 */
export function mediaMismatch(conditions: MediaConditions, facts: MediaFacts | undefined): string | undefined {
  if (Object.keys(conditions).length === 0) {
    return undefined;
  }
  if (!facts) {
    return 'media details not read yet (or Plex has none)';
  }
  const lower = (values: readonly string[]) => values.map((v) => v.toLowerCase());
  if (conditions.shape) {
    if (facts.aspectRatio === undefined) {
      return 'picture shape unknown';
    }
    if ((facts.aspectRatio >= WIDE_ASPECT) !== (conditions.shape === 'wide')) {
      return `picture is ${facts.aspectRatio.toFixed(2)}:1, not ${conditions.shape}`;
    }
  }
  if (conditions.resolution && (!facts.resolution || !conditions.resolution.includes(facts.resolution))) {
    return `resolution is ${facts.resolution ?? 'unknown'}, not ${conditions.resolution.join(' or ')}`;
  }
  if (conditions.dynamicRange) {
    const range = facts.dynamicRange;
    // "HDR" includes Dolby Vision, which is HDR too.
    const ok = range !== undefined && (conditions.dynamicRange.includes(range) || (range === 'dv' && conditions.dynamicRange.includes('hdr')));
    if (!ok) {
      return `HDR is ${range ?? 'unknown'}, not ${conditions.dynamicRange.join(' or ')}`;
    }
  }
  if (conditions.ratings && (!facts.contentRating || !lower(conditions.ratings).includes(facts.contentRating.toLowerCase()))) {
    return `rated ${facts.contentRating ?? 'nothing'}, not ${conditions.ratings.join(' or ')}`;
  }
  if (conditions.labels) {
    const labels = lower(facts.labels);
    if (!lower(conditions.labels).some((label) => labels.includes(label))) {
      return `Plex labels ${facts.labels.length ? facts.labels.join(', ') : 'none'}, not ${conditions.labels.join(' or ')}`;
    }
  }
  return undefined;
}

export function mediaMatches(conditions: MediaConditions, facts: MediaFacts | undefined): boolean {
  return mediaMismatch(conditions, facts) === undefined;
}

/** Why a filter leaves out this playback, or undefined when it allows it. For detailed logging. */
export function filterMismatch(filters: SensorFilters, context: MatchContext, names: { player?: string; library?: string } = {}): string | undefined {
  if (filters.players.length > 0 && (context.playerId === undefined || !filters.players.includes(context.playerId))) {
    return `player ${playerName(names.player ?? context.playerId ?? 'unknown')} is not chosen`;
  }
  if (filters.users.length > 0 && (context.user === undefined || !filters.users.includes(context.user))) {
    return `${context.user === undefined ? 'the person is unknown' : `${person(context.user)} is not chosen`}`;
  }
  if (!matchesFilters({ ...filters, players: [], users: [] }, context)) {
    return `library ${names.library ?? context.media?.librarySectionId ?? 'unknown'} is not chosen`;
  }
  return undefined;
}
