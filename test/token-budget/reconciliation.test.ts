/**
 * Tests for token-budget reconciliation (recordActual / recordActualSync).
 *
 * All time-dependent tests use ManualClock for deterministic behaviour.
 */

import { describe, it, expect } from 'vitest';
import { ManualClock } from '../helpers/manual-clock.js';
import { tokenBudgetLimiter } from '../../src/token-budget/budget.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_TIME = 1_000_000_000_000;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('tokenBudgetLimiter reconciliation', () => {
  describe('recordActual()', () => {
    it('with actual < estimated: remaining increases', async () => {
      const clock = new ManualClock(BASE_TIME);
      const limiter = tokenBudgetLimiter({
        budgetPerWindow: 100,
        windowMs: 60_000,
        clock,
      });

      // Estimate 50 tokens
      const checkResult = await limiter.check('key', 50);
      expect(checkResult.remaining).toBe(50);

      // Actual was only 30 — we over-estimated, so remaining should go up
      const result = await limiter.recordActual('key', 30);

      expect(result.delta).toBe(-20);
      expect(result.remaining).toBe(70);
      expect(result.overBudget).toBe(false);
    });

    it('with actual > estimated: remaining decreases', async () => {
      const clock = new ManualClock(BASE_TIME);
      const limiter = tokenBudgetLimiter({
        budgetPerWindow: 100,
        windowMs: 60_000,
        clock,
      });

      // Estimate 30 tokens
      await limiter.check('key', 30);

      // Actual was 50 — we under-estimated, so remaining should go down
      const result = await limiter.recordActual('key', 50);

      expect(result.delta).toBe(20);
      expect(result.remaining).toBe(50);
      expect(result.overBudget).toBe(false);
    });

    it('with actual > estimated causing overBudget: overBudget = true', async () => {
      const clock = new ManualClock(BASE_TIME);
      const limiter = tokenBudgetLimiter({
        budgetPerWindow: 100,
        windowMs: 60_000,
        clock,
      });

      // Estimate 60 tokens
      await limiter.check('key', 60);
      // Actual is 120 — way more than estimated, pushing total used to 120
      const result = await limiter.recordActual('key', 120);

      expect(result.delta).toBe(60);
      // Total used = 120, remaining = max(0, 100 - 120) = 0
      expect(result.remaining).toBe(0);
      // 120 > 100 → overBudget
      expect(result.overBudget).toBe(true);
    });

    it('with actual = estimated: delta = 0', async () => {
      const clock = new ManualClock(BASE_TIME);
      const limiter = tokenBudgetLimiter({
        budgetPerWindow: 100,
        windowMs: 60_000,
        clock,
      });

      await limiter.check('key', 50);
      const result = await limiter.recordActual('key', 50);

      expect(result.delta).toBe(0);
      expect(result.remaining).toBe(50);
      expect(result.overBudget).toBe(false);
    });

    it('multiple reconciliations in one window accumulate correctly', async () => {
      const clock = new ManualClock(BASE_TIME);
      const limiter = tokenBudgetLimiter({
        budgetPerWindow: 100,
        windowMs: 60_000,
        clock,
      });

      // Request 1: estimate 30, actual 25
      await limiter.check('key', 30);
      let result = await limiter.recordActual('key', 25);
      expect(result.delta).toBe(-5);
      expect(result.remaining).toBe(75);
      expect(result.overBudget).toBe(false);

      // Request 2: estimate 40, actual 45
      await limiter.check('key', 40);
      result = await limiter.recordActual('key', 45);
      expect(result.delta).toBe(5);
      // Total used = 25 + 45 = 70
      expect(result.remaining).toBe(30);
      expect(result.overBudget).toBe(false);

      // Request 3: estimate 20, actual 20
      await limiter.check('key', 20);
      result = await limiter.recordActual('key', 20);
      expect(result.delta).toBe(0);
      // Total used = 25 + 45 + 20 = 90
      expect(result.remaining).toBe(10);
      expect(result.overBudget).toBe(false);
    });

    it('throws if no pending estimate (check not called first)', async () => {
      const clock = new ManualClock(BASE_TIME);
      const limiter = tokenBudgetLimiter({
        budgetPerWindow: 100,
        windowMs: 60_000,
        clock,
      });

      await expect(limiter.recordActual('key', 50)).rejects.toThrow(
        'No pending estimate for key',
      );
    });

    it('throws if window has rotated since check', async () => {
      const clock = new ManualClock(BASE_TIME);
      const limiter = tokenBudgetLimiter({
        budgetPerWindow: 100,
        windowMs: 60_000,
        clock,
      });

      // Check consumes budget and records an estimate
      await limiter.check('key', 50);

      // Advance past the window boundary
      clock.advanceBy(60_001);

      // Reconciliation should fail because the window has rotated
      await expect(limiter.recordActual('key', 50)).rejects.toThrow(
        'No pending estimate for key',
      );
    });
  });

  describe('recordActualSync()', () => {
    it('works identically to recordActual', () => {
      const clock = new ManualClock(BASE_TIME);
      const limiter = tokenBudgetLimiter({
        budgetPerWindow: 100,
        windowMs: 60_000,
        clock,
      });

      // Use checkSync to set up a pending estimate
      limiter.checkSync('key', 50);

      const result = limiter.recordActualSync('key', 30);

      expect(result.delta).toBe(-20);
      expect(result.remaining).toBe(70);
      expect(result.overBudget).toBe(false);
    });

    it('throws synchronously if no pending estimate', () => {
      const clock = new ManualClock(BASE_TIME);
      const limiter = tokenBudgetLimiter({
        budgetPerWindow: 100,
        windowMs: 60_000,
        clock,
      });

      expect(() => limiter.recordActualSync('key', 50)).toThrow(
        'No pending estimate for key',
      );
    });

    it('throws synchronously if window has rotated', () => {
      const clock = new ManualClock(BASE_TIME);
      const limiter = tokenBudgetLimiter({
        budgetPerWindow: 100,
        windowMs: 60_000,
        clock,
      });

      limiter.checkSync('key', 50);
      // Advance past window
      clock.advanceBy(60_001);

      expect(() => limiter.recordActualSync('key', 50)).toThrow(
        'No pending estimate for key',
      );
    });

    it('state is shared between sync and async record methods', async () => {
      const clock = new ManualClock(BASE_TIME);
      const limiter = tokenBudgetLimiter({
        budgetPerWindow: 100,
        windowMs: 60_000,
        clock,
      });

      // Async check
      await limiter.check('key', 50);

      // Sync reconciliation (uses the async check's pending estimate)
      const syncResult = limiter.recordActualSync('key', 40);
      expect(syncResult.delta).toBe(-10);
      expect(syncResult.remaining).toBe(60);
    });
  });
});
