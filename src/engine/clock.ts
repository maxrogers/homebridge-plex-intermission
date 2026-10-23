export type TimerHandle = unknown;

/** Time source for the engine, replaceable in tests. */
export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/**
 * A clock whose timer callbacks never throw: an error is passed to `onError` instead, so a bug in
 * one callback can't take down Homebridge.
 */
export function guardedClock(clock: Clock, onError: (error: unknown) => void): Clock {
  return {
    now: () => clock.now(),
    setTimeout: (callback, ms) => clock.setTimeout(() => {
      try {
        callback();
      } catch (error) {
        onError(error);
      }
    }, ms),
    clearTimeout: (handle) => clock.clearTimeout(handle),
  };
}
