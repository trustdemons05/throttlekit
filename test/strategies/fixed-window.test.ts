/**
 * Fixed Window strategy tests.
 *
 * Runs the shared strategy contract test suite plus strategy-specific tests
 * for 2× boundary burst behavior (known fixed-window property).
 */

import { runStrategyTests } from '../helpers/strategy-test-runner.js';
import { createFixedWindowStrategy } from '../../src/strategies/fixed-window.js';
import { ManualClock } from '../helpers/manual-clock.js';
import type { Strategy } from '../../src/strategies/fixed-window.js';

runStrategyTests(
  'FixedWindow',
  (limit: number, windowMs: number, clock: ManualClock) =>
    createFixedWindowStrategy({ limit, windowMs, clock }),
  () => {
    // -----------------------------------------------------------------------
    // 2× boundary burst (known fixed-window property)
    // -----------------------------------------------------------------------
    it('permits 2× burst at window boundary (known fixed-window property)', () => {
      const clock = new ManualClock(0); // Start at epoch boundary
      const strategy = createFixedWindowStrategy({ limit: 5, windowMs: 1000, clock }) as Strategy;

      // Exhaust current window
      for (let i = 0; i < 5; i++) {
        const r = strategy.apply('key', 1);
        expect(r.allowed).toBe(true);
      }

      const blocked = strategy.apply('key', 1);
      expect(blocked.allowed).toBe(false);

      // Jump to just before boundary (999ms elapsed)
      clock.advanceBy(999);

      // Still in same window — blocked
      const stillBlocked = strategy.apply('key', 1);
      expect(stillBlocked.allowed).toBe(false);

      // Cross boundary by 1ms
      clock.advanceBy(2); // +2 = 1001ms total

      // New window → should allow 5 more
      const afterReset = strategy.apply('key', 1);
      expect(afterReset.allowed).toBe(true);

      // Exhaust new window immediately
      for (let i = 0; i < 4; i++) {
        strategy.apply('key', 1);
      }
      const blockedAgain = strategy.apply('key', 1);
      expect(blockedAgain.allowed).toBe(false);
    });

    // -----------------------------------------------------------------------
    // Window is properly aligned (not relative to first request)
    // -----------------------------------------------------------------------
    it('uses aligned calendar windows, not sliding windows', () => {
      const clock = new ManualClock(0); // Start at epoch 0
      const strategy = createFixedWindowStrategy({ limit: 5, windowMs: 1000, clock }) as Strategy;

      // First request at t=0 → window [0, 1000)
      const r1 = strategy.apply('key', 1);
      expect(r1.allowed).toBe(true);

      // Exhaust at t=0
      for (let i = 0; i < 4; i++) {
        strategy.apply('key', 1);
      }

      // Advance to t=500 — same window, still blocked
      clock.setTime(500);
      const at500 = strategy.apply('key', 1);
      expect(at500.allowed).toBe(false);

      // Advance to t=999 — same window, still blocked
      clock.setTime(999);
      const at999 = strategy.apply('key', 1);
      expect(at999.allowed).toBe(false);

      // Advance to t=1000 — new window starts
      clock.setTime(1000);
      const at1000 = strategy.apply('key', 1);
      expect(at1000.allowed).toBe(true);
    });

    // -----------------------------------------------------------------------
    // Zero-cost requests don't increment count
    // -----------------------------------------------------------------------
    it('cost=0 does not advance the window count', () => {
      const clock = new ManualClock(0);
      const strategy = createFixedWindowStrategy({ limit: 5, windowMs: 1000, clock }) as Strategy;

      // cost=0 should not consume
      const r0 = strategy.apply('key', 0);
      expect(r0.allowed).toBe(true);
      expect(r0.remaining).toBe(5);

      // Still 5 remaining
      const r1 = strategy.apply('key', 1);
      expect(r1.remaining).toBe(4);
    });
  },
);
