import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { ManualClock } from '../helpers/manual-clock.js';
import { adaptiveThrottle } from '../../src/admission/adaptive-throttle.js';

describe('Adaptive Throttle Properties', () => {
  it('drop probability is always >= 0 and < 1', () => {
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), { minLength: 0, maxLength: 200 }),
        fc.integer({ min: 1, max: 10 }),
        (history, k) => {
          const clock = new ManualClock(1_000_000);
          const throttle = adaptiveThrottle({
            k,
            windowMs: 30_000,
            buckets: 10,
            clock,
          });

          for (const accepted of history) {
            throttle.request();
            throttle.record(accepted);
          }

          const p = throttle.dropProbability;
          expect(p).toBeGreaterThanOrEqual(0);
          expect(p).toBeLessThan(1);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('all-accepted history => dropProbability = 0', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 200 }),
        fc.integer({ min: 1, max: 10 }),
        (count, k) => {
          const clock = new ManualClock(1_000_000);
          const throttle = adaptiveThrottle({
            k,
            windowMs: 30_000,
            buckets: 10,
            clock,
          });

          for (let i = 0; i < count; i++) {
            throttle.request();
            throttle.record(true);
          }

          expect(throttle.dropProbability).toBe(0);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('all-rejected history => dropProbability approaches but stays < 1', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200 }),
        fc.integer({ min: 1, max: 10 }),
        (count, k) => {
          const clock = new ManualClock(1_000_000);
          const throttle = adaptiveThrottle({
            k,
            windowMs: 30_000,
            buckets: 10,
            clock,
          });

          for (let i = 0; i < count; i++) {
            throttle.request();
            throttle.record(false);
          }

          const p = throttle.dropProbability;
          expect(p).toBeGreaterThan(0);
          expect(p).toBeLessThan(1);

          // Exact formula with all rejected: reqs = count, accs = 0
          // p = (count - k * 0) / (count + 1) = count / (count + 1)
          const expected = count / (count + 1);
          expect(p).toBeCloseTo(expected, 10);
        },
      ),
      { numRuns: 300 },
    );
  });
});
