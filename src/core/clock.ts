import type { Clock } from './types.js';

/**
 * Production clock: wraps Date.now().
 */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

/**
 * Test clock: time advances only when told.
 * Enables deterministic, instant tests without setTimeout.
 */
export class ManualClock implements Clock {
  private _now: number;

  constructor(initial?: number) {
    this._now = initial ?? Date.now();
  }

  now(): number {
    return this._now;
  }

  /** Advance time forward by ms */
  advanceBy(ms: number): void {
    this._now += ms;
  }

  /** Jump to a specific timestamp */
  setTime(ts: number): void {
    this._now = ts;
  }
}
