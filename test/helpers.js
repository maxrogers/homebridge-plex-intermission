import { readFile } from 'node:fs/promises';

import { PlaybackEngine } from '../dist/engine/engine.js';
import { DEFAULT_ENGINE_SETTINGS } from '../dist/engine/types.js';

/** A clock that only moves when told to, running due timers in order. */
export class FakeClock {
  #now;
  #timers = new Map();
  #nextId = 1;

  constructor(start = 1_000_000) {
    this.#now = start;
  }

  now() {
    return this.#now;
  }

  setTimeout(callback, ms) {
    const id = this.#nextId++;
    this.#timers.set(id, { at: this.#now + Math.max(0, ms), callback });
    return id;
  }

  clearTimeout(id) {
    this.#timers.delete(id);
  }

  /** Moves to `time`, firing every timer due on the way. */
  async advanceTo(time) {
    for (;;) {
      let nextId;
      let next;
      for (const [id, timer] of this.#timers) {
        if (timer.at <= time && (!next || timer.at < next.at)) {
          nextId = id;
          next = timer;
        }
      }
      if (!next) {
        break;
      }
      this.#timers.delete(nextId);
      this.#now = next.at;
      next.callback();
      await settle();
    }
    this.#now = Math.max(this.#now, time);
  }

  advance(ms) {
    return this.advanceTo(this.#now + ms);
  }
}

/** Lets pending promise callbacks run. */
export const settle = () => new Promise((resolve) => setImmediate(resolve));

export const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

export const PLAYER = 'APPLE-TV';

export function session(overrides = {}) {
  return {
    playerId: PLAYER,
    playerTitle: 'Apple TV',
    user: 'owner',
    media: { ratingKey: '1', title: 'Movie', type: 'movie', durationMs: 7_200_000, librarySectionTitle: 'Movies' },
    ...overrides,
  };
}

/** An engine with a fake clock that records every event as [type, time since start, position]. */
export function createEngine({ settings = {}, markers = [], sessions = {}, start = 1_000_000, hasCredits, resolveSession, log = silentLog } = {}) {
  const clock = new FakeClock(start);
  const events = [];
  const engine = new PlaybackEngine({
    clock,
    log,
    resolveSession: resolveSession ?? (async (playerId, sessionKey) => sessions[sessionKey] ?? session()),
    getMarkers: async (ratingKey) => (typeof markers === 'function' ? markers(ratingKey) : markers),
    hasCredits,
  }, { ...DEFAULT_ENGINE_SETTINGS, ...settings });
  engine.on('event', (event) => events.push([event.type, event.at - start, event.positionMs]));
  return { engine, clock, events, start };
}

export function credits(startMs, extra = {}) {
  return { type: 'credits', startMs, endMs: startMs + 200_000, final: true, ...extra };
}

export async function loadFixture(name) {
  return JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}
