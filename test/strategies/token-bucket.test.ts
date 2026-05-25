/**
 * Token Bucket strategy tests.
 *
 * Runs the shared strategy contract test suite plus strategy-specific tests
 * for token refill, capacity enforcement, rate=0 edge cases, and fractional
 * token handling.
 */

import { it, expect } from 'vitest';
import { runStrategyTests } from '../helpers/strategy-test-runner.js';
import { createTokenBucketStrategy } from '../../src/strategies/token-bucket.js';
import { ManualClock } from '../helpers/manual-clock.js';
import type { Strategy } from '../../src/strategies/token-bucket.js';

runStrategyTests(
  'TokenBucket',
  (limit: number, windowMs: number, clock: ManualClock) =>
    createTokenBucketStrategy({
      capacity: limit,
      refillRate: limit / (windowMs / 1000),
      clock,
    }),
  () => {
    // -----------------------------------------------------------------------
    // Refills tokens over time
    // -----------------------------------------------------------------------
    it('refills tokens over time', () => {
      const clock = new ManualClock();
      const strategy = createTokenBucketStrategy({
        capacity: 10,
        refillRate: 5, // 5 tokens/second
        clock,
      }) as Strategy;

      // Exhaust bucket
      for (let i = 0; i < 10; i++) {
        strategy.apply('key', 1);
      }

      const stillBlocked = strategy.apply('key', 1);
      expect(stillBlocked.allowed).toBe(false);

      // Wait 1 second → 5 tokens should have refilled
      clock.advanceBy(1000);

      const afterRefill = strategy.apply('key', 1);
      expect(afterRefill.allowed).toBe(true);
      expect(afterRefill.remaining).toBe(4); // 5 - 1
    });

    // -----------------------------------------------------------------------
    // Never exceeds capacity
    // -----------------------------------------------------------------------
    it('never exceeds capacity after long idle', () => {
      const clock = new ManualClock();
      const strategy = createTokenBucketStrategy({
        capacity: 10,
        refillRate: 100, // much faster than capacity
        clock,
      }) as Strategy;

      // Use 1 token
      const r1 = strategy.apply('key', 1);
      expect(r1.remaining).toBe(9);

      // Wait a long time — bucket should cap at capacity
      clock.advanceBy(100_000);

      const result = strategy.apply('key', 0);
      expect(result.remaining).toBe(10);
    });

    // -----------------------------------------------------------------------
    // Handles rate=0 correctly
    // -----------------------------------------------------------------------
    it('handles rate=0 correctly (full bucket allows, empty bucket rejects forever)', () => {
      const clock = new ManualClock();
      const strategy = createTokenBucketStrategy({
        capacity: 5,
        refillRate: 0,
        clock,
      }) as Strategy;

      // Initial: full bucket (5 tokens) — should allow
      const r1 = strategy.apply('key', 1);
      expect(r1.allowed).toBe(true);
      expect(r1.remaining).toBe(4);

      // Exhaust bucket
      for (let i = 0; i < 4; i++) {
        strategy.apply('key', 1);
      }

      // Now empty and rate=0 → blocked forever
      const blocked = strategy.apply('key', 1);
      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfterMs).toBe(Infinity);
      expect(blocked.remaining).toBe(0);

      // Even after waiting, still blocked (no refill)
      clock.advanceBy(10_000);
      const stillBlocked = strategy.apply('key', 1);
      expect(stillBlocked.allowed).toBe(false);
      expect(stillBlocked.retryAfterMs).toBe(Infinity);
    });

    // -----------------------------------------------------------------------
    // Supports fractional tokens
    // -----------------------------------------------------------------------
    it('supports fractional tokens (remaining = floor of available)', () => {
      const clock = new ManualClock(0); // Start at epoch 0
      const strategy = createTokenBucketStrategy({
        capacity: 10,
        refillRate: 1, // 1 token/second
        clock,
      }) as Strategy;

      // Use 9 tokens
      for (let i = 0; i < 9; i++) {
        strategy.apply('key', 1);
      }
      expect(strategy.peek!('key')!.remaining).toBe(1);

      // Use that last token
      const lastAllowed = strategy.apply('key', 1);
      expect(lastAllowed.allowed).toBe(true);
      expect(lastAllowed.remaining).toBe(0);

      // Wait 500ms — 0.5 token accumulated (floor = 0)
      clock.advanceBy(500);
      const peekRemaining = strategy.peek!('key')!.remaining;
      expect(peekRemaining).toBe(0); // floor(0.5) = 0

      // A cost=1 request should be blocked (0.5 < 1)
      const blocked = strategy.apply('key', 1);
      expect(blocked.allowed).toBe(false);

      // Wait another 500ms — now 1 full token available
      clock.advanceBy(500);
      const allowed = strategy.apply('key', 1);
      expect(allowed.allowed).toBe(true);
      expect(allowed.remaining).toBe(0);
    });
  },
);
