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
