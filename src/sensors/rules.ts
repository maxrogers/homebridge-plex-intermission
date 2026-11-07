import type { DeviceConfig, Exception, MediaConditions, SensorFilters, StateCondition } from '../config.js';
import { person, player as playerName } from '../diagnostics.js';
import { WIDE_ASPECT, type MediaFacts } from '../plex/media-facts.js';
import type { MediaInfo, PlayerSnapshot, SessionInfo } from '../engine/types.js';

/** What an event or session offers to match against. Missing fields fail any filter on them. */
export interface MatchContext {
  /** The server the event came from. Library filters may name `serverId/sectionId`. */
  serverId?: string;
  playerId?: string;
  /** Chosen players this player is followed as, after Plex gave it a new ID (see PlayerBook). */
  followedAs?: readonly string[];
  /** The name the player reports, for device filters. */
  playerName?: string;
  /** Whether the player is on the home network: Plex says it is local, or its address is private. */
  home?: boolean;
  user?: string;
  media?: MediaInfo;
}

export function contextOf(session: SessionInfo | undefined, media?: MediaInfo, serverId?: string, extra: Partial<MatchContext> = {}): MatchContext {
  const context: MatchContext = { serverId, playerId: session?.playerId, user: session?.user, media: session?.media ?? media };
  if (extra.followedAs?.length) {
    context.followedAs = extra.followedAs;
  }
  const name = extra.playerName ?? session?.playerTitle;
  if (name !== undefined) {
    context.playerName = name;
  }
  const home = extra.home ?? isHome(session);
  if (home !== undefined) {
    context.home = home;
  }
  return context;
}

const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|fd|fc|fe80:|::1$)/i;

/** A private (LAN or VPN) address: a player outside the home reaches the server from a public one. */
export function isPrivateAddress(address: string | undefined): boolean {
  return address !== undefined && PRIVATE.test(address.replace(/^::ffff:/i, ''));
}

/** Home if Plex calls the player local or its address is private; undefined when neither is known. */
export function isHome(player: { local?: boolean; address?: string } | undefined): boolean | undefined {
  if (player?.local === true || isPrivateAddress(player?.address)) {
    return true;
  }
  return player?.local === false ? false : undefined;
}

const sameName = (a?: string, b?: string) => a !== undefined && b !== undefined && a.trim().toLowerCase() === b.trim().toLowerCase();

function hasApp(ids: readonly string[], context: MatchContext): boolean {
  return (context.playerId !== undefined && ids.includes(context.playerId)) || (context.followedAs ?? []).some((id) => ids.includes(id));
}

/** Whether a playback is on a device: one of its apps, or any app reporting its name on the home network. */
export function onDevice(device: DeviceConfig, context: MatchContext): boolean {
  if (device.apps.length > 0) {
    return hasApp(device.apps, context);
  }
  return device.match !== undefined && sameName(device.match, context.playerName) && context.home === true;
}

function playerAllowed(filters: SensorFilters, context: MatchContext): boolean {
  if (context.playerId !== undefined && (filters.exceptPlayers ?? []).includes(context.playerId)) {
    return false;
  }
  const devices = filters.devices ?? [];
  if (filters.players.length === 0 && devices.length === 0) {
    return true;
  }
  return hasApp(filters.players, context) || devices.some((device) => onDevice(device, context));
}

/** An empty filter allows everything; a non-empty one must contain the value. */
export function matchesFilters(filters: SensorFilters, context: MatchContext): boolean {
  const allows = (values: readonly string[], actual: string | undefined) =>
    values.length === 0 || (actual !== undefined && values.includes(actual));
  const section = context.media?.librarySectionId;
  const library = filters.libraries.length === 0 || (section !== undefined
    && (filters.libraries.includes(section) || (context.serverId !== undefined && filters.libraries.includes(`${context.serverId}/${section}`))));
  return playerAllowed(filters, context) && allows(filters.users, context.user) && library;
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
export function filterMismatch(
  filters: SensorFilters,
  context: MatchContext,
  names: { player?: string; product?: string; library?: string } = {},
): string | undefined {
  if (context.playerId !== undefined && (filters.exceptPlayers ?? []).includes(context.playerId)) {
    return `player ${playerName(names.player ?? context.playerId)}${names.player ? ` (${names.product ?? context.playerId.slice(0, 8)})` : ''} is left out of its device`;
  }
  if (!playerAllowed(filters, context)) {
    const devices = filters.devices ?? [];
    const named = devices.find((d) => d.apps.length === 0 && sameName(d.match, context.playerName));
    if (named && context.home !== true) {
      return `player ${playerName(names.player ?? context.playerId ?? 'unknown')} is not on the home network (${context.home === false ? 'Plex says it is remote' : 'its address is unknown'})`;
    }
    // The app or ID tells apart players with the same name, such as two apps on one Apple TV.
    const tell = names.product ?? context.playerId?.slice(0, 8);
    return `player ${playerName(names.player ?? context.playerId ?? 'unknown')}${names.player && tell ? ` (${tell})` : ''} is not chosen`;
  }
  if (filters.users.length > 0 && (context.user === undefined || !filters.users.includes(context.user))) {
    return `${context.user === undefined ? 'the person is unknown' : `${person(context.user)} is not chosen`}`;
  }
  if (!matchesFilters({ ...filters, players: [], devices: [], exceptPlayers: [], users: [] }, context)) {
    return `library ${names.library ?? context.media?.librarySectionId ?? 'unknown'} is not chosen`;
  }
  return undefined;
}
