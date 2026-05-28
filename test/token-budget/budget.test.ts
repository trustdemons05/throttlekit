/**
 * Tests for the token-budget limiter (check, checkSync, peek, reset, estimateCost).
 *
 * All time-dependent tests use ManualClock for deterministic behaviour.
 */

import { describe, it, expect } from 'vitest';
import { ManualClock } from '../helpers/manual-clock.js';
import { tokenBudgetLimiter } from '../../src/token-budget/budget.js';
import type { TokenBudgetOptions, TokenEstimator } from '../../src/token-budget/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_TIME = 1_000_000_000_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createLimiter(
  budgetPerWindow: number,
  windowMs: number,
  clock?: ManualClock,
  estimator?: TokenEstimator,
) {
  const opts: TokenBudgetOptions = {
    budgetPerWindow,
    windowMs,
    clock: clock ?? new ManualClock(BASE_TIME),
  };
  if (estimator !== undefined) {
    opts.estimator = estimator;
  }
  return tokenBudgetLimiter(opts);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('tokenBudgetLimiter', () => {
  describe('check()', () => {
    it('allows request within budget', async () => {
      const clock = new ManualClock(BASE_TIME);
      const limiter = createLimiter(100, 60_000, clock);

      const result = await limiter.check('key', 50);

      expect(result.allowed).toBe(true);
      expect(result.budget).toBe(100);
      expect(result.remaining).toBe(50);
      expect(result.estimatedTokens).toBe(50);
      expect(result.retryAfterMs).toBe(0);
      expect(result.resetAt).toBe(BASE_TIME + 60_000);
    });

    it('denies request over budget', async () => {
      const clock = new ManualClock(BASE_TIME);
      const limiter = createLimiter(100, 60_000, clock);

      // Consume 80 tokens
      await limiter.check('key', 80);
      // Try to consume a further 30 — would exceed the 100 budget
      const result = await limiter.check('key', 30);

      expect(result.allowed).toBe(false);
      expect(result.budget).toBe(100);
      expect(result.remaining).toBe(20);
      expect(result.estimatedTokens).toBe(30);
      expect(result.retryAfterMs).toBeGreaterThan(0);
      // retryAfterMs should equal resetAt - now = BASE_TIME + 60000 - BASE_TIME
      expect(result.retryAfterMs).toBe(60_000);
    });

    it('window rotation resets budget', async () => {
      const clock = new ManualClock(BASE_TIME);
      const limiter = createLimiter(100, 60_000, clock);

      // Exhaust the budget
      await limiter.check('key', 100);
      expect((await limiter.check('key', 1)).allowed).toBe(false);

      // Advance past the window boundary
      clock.advanceBy(60_001);

      // Budget should be fully reset
      const result = await limiter.check('key', 50);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(50);
    });

    it('remaining decreases correctly after multiple checks', async () => {
      const clock = new ManualClock(BASE_TIME);
      const limiter = createLimiter(100, 60_000, clock);

      const r1 = await limiter.check('key', 30);
      expect(r1.remaining).toBe(70);

      const r2 = await limiter.check('key', 20);
      expect(r2.remaining).toBe(50);

      const r3 = await limiter.check('key', 40);
      expect(r3.remaining).toBe(10);

      // Total used = 90, next request for 20 would exceed the 100 budget
      const r4 = await limiter.check('key', 20);
      expect(r4.allowed).toBe(false);
    });

    it('multiple keys are independent', async () => {
      const clock = new ManualClock(BASE_TIME);
      const limiter = createLimiter(100, 60_000, clock);

      const r1 = await limiter.check('alpha', 80);
      expect(r1.allowed).toBe(true);
      expect(r1.remaining).toBe(20);

      // 'beta' should start with a full budget
      const r2 = await limiter.check('beta', 80);
      expect(r2.allowed).toBe(true);
      expect(r2.remaining).toBe(20);

      // 'alpha' still has 20 (unchanged by beta's usage)
      const r3 = await limiter.check('alpha', 15);
      expect(r3.allowed).toBe(true);
      expect(r3.remaining).toBe(5);
    });
  });

  describe('estimateCost()', () => {
    it('uses default (chars/4) when no custom estimator is provided', () => {
      const limiter = createLimiter(1000, 60_000);

      // "hello" = 5 chars → ceil(5/4) = 2
      expect(limiter.estimateCost('hello')).toBe(2);
      // "hello world" = 11 chars → ceil(11/4) = 3
      expect(limiter.estimateCost('hello world')).toBe(3);
      // "" = 0 chars → ceil(0/4) = 0
      expect(limiter.estimateCost('')).toBe(0);
      // "a" = 1 char → ceil(1/4) = 1
      expect(limiter.estimateCost('a')).toBe(1);
    });

    it('uses custom estimator when provided in options', () => {
      const estimator: TokenEstimator = {
        estimate: (text: string) => text.length,
      };
      const clock = new ManualClock(BASE_TIME);
      const limiter = createLimiter(1000, 60_000, clock, estimator);

      expect(limiter.estimateCost('hello')).toBe(5);
      expect(limiter.estimateCost('')).toBe(0);
      expect(limiter.estimateCost('abc')).toBe(3);
    });
  });

  describe('checkSync()', () => {
    it('works identically to check', () => {
      const clock = new ManualClock(BASE_TIME);
      const limiter = createLimiter(100, 60_000, clock);

      // First check — should be allowed
      const r1 = limiter.checkSync('key', 40);
      expect(r1.allowed).toBe(true);
      expect(r1.remaining).toBe(60);

      // Second check within budget — should be allowed
      const r2 = limiter.checkSync('key', 30);
      expect(r2.allowed).toBe(true);
      expect(r2.remaining).toBe(30);

      // Third check over budget — should be denied
      const r3 = limiter.checkSync('key', 40);
      expect(r3.allowed).toBe(false);
      expect(r3.remaining).toBe(30);

      // State was NOT modified by the denied check; remaining is still 30.
      // A small request within remaining budget should be allowed.
      const r4 = limiter.checkSync('key', 20);
      expect(r4.allowed).toBe(true);
      expect(r4.remaining).toBe(10);
    });

    it('produces same results as async check', async () => {
      const clock = new ManualClock(BASE_TIME);
      const limiter = createLimiter(100, 60_000, clock);

      const syncResult = limiter.checkSync('key-sync', 50);
      const asyncResult = await limiter.check('key-async', 50);

      expect(syncResult.allowed).toBe(asyncResult.allowed);
      expect(syncResult.remaining).toBe(asyncResult.remaining);
      expect(syncResult.budget).toBe(asyncResult.budget);
      expect(syncResult.estimatedTokens).toBe(asyncResult.estimatedTokens);
    });
  });

  describe('peek()', () => {
    it('does not consume budget', async () => {
      const clock = new ManualClock(BASE_TIME);
      const limiter = createLimiter(100, 60_000, clock);

      // Consume 40 tokens
      await limiter.check('key', 40);

      // Peek — should show 60 remaining
      const peekResult = await limiter.peek('key');
      expect(peekResult.remaining).toBe(60);
      expect(peekResult.allowed).toBe(true);
      expect(peekResult.estimatedTokens).toBe(0);

      // Subsequent check should still see 60 remaining (peek didn't consume)
      const checkResult = await limiter.check('key', 30);
      expect(checkResult.remaining).toBe(30);
    });

    it('returns full budget for an unknown key', async () => {
      const clock = new ManualClock(BASE_TIME);
      const limiter = createLimiter(100, 60_000, clock);

      const result = await limiter.peek('nonexistent');
      expect(result.remaining).toBe(100);
      expect(result.allowed).toBe(true);
      expect(result.resetAt).toBe(BASE_TIME + 60_000);
    });

    it('returns full budget after window rotation', async () => {
      const clock = new ManualClock(BASE_TIME);
      const limiter = createLimiter(100, 60_000, clock);

      // Consume some tokens
      await limiter.check('key', 80);
      expect((await limiter.peek('key')).remaining).toBe(20);

      // Advance past the window boundary
      clock.advanceBy(60_001);

      // Budget should be fully restored
      const result = await limiter.peek('key');
      expect(result.remaining).toBe(100);
      expect(result.allowed).toBe(true);
    });
  });

  describe('overshoot bound (local single-instance)', () => {
    it('never allows total used tokens to exceed budgetPerWindow', () => {
      const clock = new ManualClock(BASE_TIME);
      const limiter = createLimiter(100, 60_000, clock);

      let totalAllowed = 0;

      // Rapid sequential debits at various sizes — total requested far > budget
      const debits = [51, 51, 20, 20, 10, 10, 5, 5];
      for (const d of debits) {
        const result = limiter.checkSync('key', d);
        if (result.allowed) {
          totalAllowed += d;
        }
      }

      // The local implementation is synchronous/atomic so overshoot is 0.
      // 51 allowed (used=51), 51 denied, 20 allowed (used=71), 20 allowed (used=91),
      // 10 denied, 10 denied, 5 allowed (used=96), 5 denied
      expect(totalAllowed).toBeLessThanOrEqual(100);
      expect(totalAllowed).toBe(96);
    });

    it('single debit exceeding full budget is denied immediately', () => {
      const clock = new ManualClock(BASE_TIME);
      const limiter = createLimiter(100, 60_000, clock);

      const result = limiter.checkSync('key', 101);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(100);
    });

    it('exact budget boundary allows all tokens', () => {
      const clock = new ManualClock(BASE_TIME);
      const limiter = createLimiter(100, 60_000, clock);

      const r1 = limiter.checkSync('key', 100);
      expect(r1.allowed).toBe(true);
      expect(r1.remaining).toBe(0);

      // Next request must be denied
      const r2 = limiter.checkSync('key', 1);
      expect(r2.allowed).toBe(false);
      expect(r2.remaining).toBe(0);
    });

    it('overshoot bound simulation: D_max - 1 worst case in single instance is 0', () => {
      // With a single instance, the atomic check prevents any overshoot.
      // This test simulates the worst-case scenario for a distributed
      // system (where D_max - 1 would be the bound) and verifies the
      // local implementation is actually stricter.
      const L = 100;
      const D_max = 60;
      const clock = new ManualClock(BASE_TIME);
      const limiter = createLimiter(L, 60_000, clock);

      let totalAllowed = 0;
      const attempts = 10;

      for (let i = 0; i < attempts; i++) {
        const result = limiter.checkSync('key', D_max);
        if (result.allowed) {
          totalAllowed += D_max;
        }
      }

      // Local: only one debit of 60 passes (60 ≤ 100)
      // Total allowed ≤ L (strict bound of 0 overshoot)
      expect(totalAllowed).toBeLessThanOrEqual(L);
      expect(totalAllowed).toBe(60);
    });
  });

  describe('reset()', () => {
    it('clears budget for a key', async () => {
      const clock = new ManualClock(BASE_TIME);
      const limiter = createLimiter(100, 60_000, clock);

      await limiter.check('key', 80);
      expect((await limiter.peek('key')).remaining).toBe(20);

      await limiter.reset('key');

      // After reset the key should have a full budget
      const result = await limiter.peek('key');
      expect(result.remaining).toBe(100);
    });

    it('allows previously denied key to be used again', async () => {
      const clock = new ManualClock(BASE_TIME);
      const limiter = createLimiter(100, 60_000, clock);

      // Exhaust the budget
      await limiter.check('key', 100);
      expect((await limiter.check('key', 1)).allowed).toBe(false);

      // Reset
      await limiter.reset('key');

      // Should be able to use again
      const result = await limiter.check('key', 50);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(50);
    });
  });
});
