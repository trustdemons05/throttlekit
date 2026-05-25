/**
 * Shared contract test suite for rate-limiting strategies.
 *
 * Usage:
 * ```typescript
 * import { runStrategyTests } from '../helpers/strategy-test-runner.js';
 * import { MyStrategy } from './my-strategy.js';
 *
 * runStrategyTests('MyStrategy', (limit, windowMs, clock) => new MyStrategy(limit, windowMs, clock));
 * ```
 *
 * A strategy factory receives (limit, windowMs, clock) and returns a Strategy.
 * The shared contract tests validate that any strategy correctly:
 *  - Tracks request counts per key per window
 *  - Enforces the configured limit
 *  - Handles window boundaries (reset)
 *  - Supports state serialization (if implemented)
 *  - Handles concurrent requests at the same clock tick
 */
import { ManualClock } from './manual-clock.js';
import { simulateConcurrentSync } from './concurrent.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterMs: number;
}

export interface Strategy {
  apply(key: string, cost: number): RateLimitResult;
  peek?(key: string): RateLimitResult | null;
  exportState?(key: string): unknown;
  importState?(key: string, state: unknown): void;
}

export type StrategyFactory = (
  limit: number,
  windowMs: number,
  clock: ManualClock
) => Strategy;

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run the shared strategy contract test suite under the given describe block.
 *
 * @param name - Display name for the describe block
 * @param createStrategy - Factory that creates a fresh strategy instance
 * @param specificTests - Optional callback to add strategy-specific tests
 */
export function runStrategyTests(
  name: string,
  createStrategy: StrategyFactory,
  specificTests?: () => void
): void {
  describe(`Strategy contract: ${name}`, () => {
    const LIMIT = 5;
    const WINDOW_MS = 1000;
    const KEY = 'test-key';

    let strategy: Strategy;
    let clock: ManualClock;

    beforeEach(() => {
      clock = new ManualClock();
      strategy = createStrategy(LIMIT, WINDOW_MS, clock);
    });

    // -----------------------------------------------------------------------
    // 1 – First request
    // -----------------------------------------------------------------------
    it('allows first request and returns correct remaining', () => {
      const result = strategy.apply(KEY, 1);

      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(LIMIT);
      expect(result.remaining).toBe(LIMIT - 1);
    });

    // -----------------------------------------------------------------------
    // 2 – Exhaust limit
    // -----------------------------------------------------------------------
    it('allows exactly LIMIT requests then blocks', () => {
      for (let i = 0; i < LIMIT; i++) {
        const result = strategy.apply(KEY, 1);
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(LIMIT - 1 - i);
      }

      const blocked = strategy.apply(KEY, 1);
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);
    });

    // -----------------------------------------------------------------------
    // 3 – Key isolation
    // -----------------------------------------------------------------------
    it('tracks separate state per key', () => {
      const r1 = strategy.apply('key-a', 1);
      const r2 = strategy.apply('key-b', 1);

      expect(r1.allowed).toBe(true);
      expect(r1.remaining).toBe(LIMIT - 1);
      expect(r2.allowed).toBe(true);
      expect(r2.remaining).toBe(LIMIT - 1);

      // Exhaust key-a
      for (let i = 0; i < LIMIT - 1; i++) {
        strategy.apply('key-a', 1);
      }

      const blocked = strategy.apply('key-a', 1);
      expect(blocked.allowed).toBe(false);

      // key-b should still be fresh
      const freshB = strategy.apply('key-b', 1);
      expect(freshB.allowed).toBe(true);
      expect(freshB.remaining).toBe(LIMIT - 2);
    });

    // -----------------------------------------------------------------------
    // 4 – Zero-cost
    // -----------------------------------------------------------------------
    it('cost=0 does not consume capacity', () => {
      const r1 = strategy.apply(KEY, 0);
      expect(r1.allowed).toBe(true);
      expect(r1.remaining).toBe(LIMIT);

      // A real request should see full capacity
      const r2 = strategy.apply(KEY, 1);
      expect(r2.allowed).toBe(true);
      expect(r2.remaining).toBe(LIMIT - 1);
    });

    // -----------------------------------------------------------------------
    // 5 – Over-limit cost
    // -----------------------------------------------------------------------
    it('cost > LIMIT is immediately rejected', () => {
      const result = strategy.apply(KEY, LIMIT + 1);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(LIMIT);
    });

    // -----------------------------------------------------------------------
    // 6 – Exact remaining
    // -----------------------------------------------------------------------
    it('cost = remaining exactly allows the last request', () => {
      // Consume 1 unit
      strategy.apply(KEY, 1);

      // Spend exactly the remaining capacity
      const exact = strategy.apply(KEY, LIMIT - 1);
      expect(exact.allowed).toBe(true);
      expect(exact.remaining).toBe(0);

      // Now blocked
      const blocked = strategy.apply(KEY, 1);
      expect(blocked.allowed).toBe(false);
    });

    // -----------------------------------------------------------------------
    // 7 – retryAfterMs
    // -----------------------------------------------------------------------
    it('retryAfterMs is 0 when allowed, >0 when blocked', () => {
      const allowed = strategy.apply(KEY, 1);
      expect(allowed.retryAfterMs).toBe(0);

      // Exhaust
      for (let i = 0; i < LIMIT - 1; i++) {
        strategy.apply(KEY, 1);
      }

      const blocked = strategy.apply(KEY, 1);
      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfterMs).toBeGreaterThan(0);
    });

    // -----------------------------------------------------------------------
    // 8 – retryAfterMs accuracy
    // -----------------------------------------------------------------------
    it('retryAfterMs matches actual time until reset', () => {
      // Exhaust
      for (let i = 0; i < LIMIT; i++) {
        strategy.apply(KEY, 1);
      }

      const blocked = strategy.apply(KEY, 1);
      const now = clock.now();
      const expectedRetry = blocked.resetAt - now;

      expect(blocked.retryAfterMs).toBe(expectedRetry);
    });

    // -----------------------------------------------------------------------
    // 9 – resetAt in future when blocked
    // -----------------------------------------------------------------------
    it('resetAt is in the future when blocked', () => {
      // Exhaust
      for (let i = 0; i < LIMIT; i++) {
        strategy.apply(KEY, 1);
      }

      const blocked = strategy.apply(KEY, 1);
      expect(blocked.resetAt).toBeGreaterThan(clock.now());
    });

    // -----------------------------------------------------------------------
    // 10 – State serialization roundtrip
    // -----------------------------------------------------------------------
    it('state serialization roundtrip (JSON.stringify + JSON.parse) if exportState/importState exist', () => {
      // Skip if methods not implemented
      if (!strategy.exportState || !strategy.importState) {
        return;
      }

      // Make some progress on key-a
      strategy.apply('key-a', 1);
      strategy.apply('key-a', 1);

      const stateA = strategy.exportState('key-a');

      // Serialize / deserialize (simulates Redis / network)
      const cloned = JSON.parse(JSON.stringify(stateA));

      // Import into a fresh key
      strategy.importState('key-b', cloned);

      const resultA = strategy.apply('key-a', 1);
      const resultB = strategy.apply('key-b', 1);

      // Both should reflect same remaining after one more call
      expect(resultA.remaining).toBe(resultB.remaining);
    });

    // -----------------------------------------------------------------------
    // 11 – Window boundary reset
    // -----------------------------------------------------------------------
    it('window boundary resets correctly (exhaust, cross boundary, allow again)', () => {
      // Exhaust within current window
      for (let i = 0; i < LIMIT; i++) {
        strategy.apply(KEY, 1);
      }

      const blocked = strategy.apply(KEY, 1);
      expect(blocked.allowed).toBe(false);

      // Advance clock past the window boundary
      clock.advanceBy(WINDOW_MS + 1);

      // Should be allowed again in the new window
      const afterReset = strategy.apply(KEY, 1);
      expect(afterReset.allowed).toBe(true);
      expect(afterReset.remaining).toBe(LIMIT - 1);
    });

    // -----------------------------------------------------------------------
    // 12 – Concurrent requests at same clock tick
    // -----------------------------------------------------------------------
    it('CRITICAL: exactly K of N concurrent requests allowed (use simulateConcurrentSync)', () => {
      const N = 20;
      const results = simulateConcurrentSync(() => strategy.apply(KEY, 1), N);

      const allowed = results.filter((r) => r.allowed).length;
      const blocked = results.filter((r) => !r.allowed).length;

      expect(allowed).toBe(LIMIT);
      expect(blocked).toBe(N - LIMIT);
    });

    // -----------------------------------------------------------------------
    // Strategy-specific tests
    // -----------------------------------------------------------------------
    if (specificTests) {
      describe('strategy-specific', () => {
        specificTests();
      });
    }
  });
}
