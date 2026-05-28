import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { ManualClock } from '../helpers/manual-clock.js';
import { createGcraStrategy, gcraConsume } from '../../src/strategies/gcra.js';

describe('GCRA Cost Properties', () => {
  it('with cost>1 from fresh state, TAT advances by cost * emission_interval from baseline', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 50 }),
        fc.integer({ min: 2, max: 100 }),
        fc.integer({ min: 100, max: 10_000 }),
        fc.integer({ min: 1_000_000, max: 2_000_000 }),
        (cost, limit, periodMs, now) => {
          fc.pre(cost <= limit);
          const emissionInterval = periodMs / limit;
          const burst = limit;

          // Baseline: cost=1 from fresh state
          const baseline = gcraConsume(null, now, 1, limit, periodMs, burst);
          expect(baseline.result.allowed).toBe(true);
          const tat1 = baseline.state[0]!;

          // Cost=C from fresh state
          const withCost = gcraConsume(null, now, cost, limit, periodMs, burst);
          expect(withCost.result.allowed).toBe(true);
          const tatC = withCost.state[0]!;

          expect(tatC - tat1).toBeCloseTo((cost - 1) * emissionInterval, 8);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('newTat follows the precise formula when allowed', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 50 }),
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 100, max: 10_000 }),
        fc.integer({ min: 1_000_000, max: 2_000_000 }),
        fc.integer({ min: 0, max: 500 }),
        (cost, limit, periodMs, now, oldTatOffset) => {
          fc.pre(cost <= limit);
          const emissionInterval = periodMs / limit;
          const burst = limit;
          const oldTat = now + oldTatOffset;
          const state = new Float64Array([oldTat]);

          const result = gcraConsume(state, now, cost, limit, periodMs, burst);

          if (result.result.allowed) {
            const newTat = result.state[0]!;
            const expectedTat = Math.max(now, oldTat) + emissionInterval * cost;
            expect(newTat).toBeCloseTo(expectedTat, 9);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('remaining is in [0, limit] for any cost', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 100, max: 10_000 }),
        (cost, limit, periodMs) => {
          const clock = new ManualClock(1_000_000);
          const strategy = createGcraStrategy({
            limit,
            periodMs,
            burst: limit,
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
        (cost, limit, periodMs) => {
          const clock = new ManualClock(1_000_000);
          const strategy = createGcraStrategy({
            limit,
            periodMs,
            burst: limit,
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
