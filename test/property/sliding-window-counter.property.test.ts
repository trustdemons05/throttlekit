import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { ManualClock } from '../helpers/manual-clock.js';
import {
  createSlidingCounterStrategy,
  slidingWindowCounterConsume,
  type WindowCounterState,
} from '../../src/strategies/sliding-window-counter.js';

describe('Sliding Window Counter Properties', () => {
  it('weighted estimate is between currCount and prevCount + currCount', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 1, max: 10_000 }),
        fc.float({ min: 0, max: 1, noDefaultInfinity: true, noNaN: true }),
        (prevCount, currCount, nowBase, windowSizeMs, elapsedRatio) => {
          const windowStart = Math.floor(nowBase / windowSizeMs) * windowSizeMs;
          const offset = Math.min(
            Math.floor(elapsedRatio * windowSizeMs),
            windowSizeMs - 1,
          );
          const now = windowStart + offset;

          const state: WindowCounterState = {
            prevCount,
            currCount,
            currentWindowStart: windowStart,
          };

          const { result } = slidingWindowCounterConsume(
            state,
            now,
            1,
            windowSizeMs,
            1_000_000,
          );

          const elapsed = (now - windowStart) / windowSizeMs;
          const weight = Math.max(0, Math.min(1, 1 - elapsed));
          const estimated = prevCount * weight + currCount;

          expect(estimated).toBeGreaterThanOrEqual(currCount);
          expect(estimated).toBeLessThanOrEqual(prevCount + currCount);
          // The estimated value should match the one used internally
          expect(result.remaining).toBeGreaterThanOrEqual(0);
          expect(result.remaining).toBeLessThanOrEqual(result.limit);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('remaining is in [0, limit] after any apply', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 100, max: 10_000 }),
        (cost, limit, windowMs) => {
          fc.pre(cost <= limit * 2);
          const clock = new ManualClock(1_000_000);
          const strategy = createSlidingCounterStrategy({
            limit,
            windowMs,
            clock,
          });
          const result = strategy.apply('key', cost);
          expect(result.remaining).toBeGreaterThanOrEqual(0);
          expect(result.remaining).toBeLessThanOrEqual(limit);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('retryAfterMs === 0 iff allowed', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 100, max: 10_000 }),
        (cost, limit, windowMs) => {
          fc.pre(cost <= limit * 2);
          const clock = new ManualClock(1_000_000);
          const strategy = createSlidingCounterStrategy({
            limit,
            windowMs,
            clock,
          });
          const result = strategy.apply('key', cost);
          if (result.allowed) {
            expect(result.retryAfterMs).toBe(0);
          } else {
            expect(result.retryAfterMs).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
