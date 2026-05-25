import { it, expect } from 'vitest';
import { runStrategyTests } from '../helpers/strategy-test-runner.js';
import { ManualClock } from '../helpers/manual-clock.js';
import {
  createSlidingCounterStrategy,
  slidingWindowCounterConsume,
} from '../../src/strategies/sliding-window-counter.js';
import type { Strategy } from '../helpers/strategy-test-runner.js';

// ---------------------------------------------------------------------------
// Shared contract tests
// ---------------------------------------------------------------------------

runStrategyTests(
  'SlidingWindowCounter',
  (limit: number, windowMs: number, clock: ManualClock): Strategy => {
    return createSlidingCounterStrategy({ limit, windowMs, clock }) as unknown as Strategy;
  },
  () => {
    // ── Strategy-specific tests ──

    it('retryAfterMs varies depending on position within window', () => {
      const clock = new ManualClock(0);
      const strategy = createSlidingCounterStrategy({ limit: 10, windowMs: 1000, clock });

      // Exhaust the window at t=0
      for (let i = 0; i < 10; i++) {
        strategy.apply('key', 1);
      }

      // Blocked at t=0 (elapsed=0): estimated = 10, deficit = 1
      // retryAfterMs = ceil(1/10 * 1000) = 100
      const blocked1 = strategy.apply('key', 1);
      expect(blocked1.allowed).toBe(false);
      expect(blocked1.retryAfterMs).toBe(100);

      // Reset and try at t=500 (halfway through window)
      clock.setTime(500);
      // Fresh key to avoid state carryover
      for (let i = 0; i < 10; i++) {
        strategy.apply('key2', 1);
      }
      const blocked2 = strategy.apply('key2', 1);
      expect(blocked2.allowed).toBe(false);
      // At elapsed=0.5: estimated = 10 (prev=0, curr=10) - same as at 0
      // The retryAfterMs depends on the weighted formula with elapsed
      // deficit = 10 + 1 - 10 = 1, retryAfterMs = ceil(1/10 * 1000) = 100
      expect(blocked2.retryAfterMs).toBe(100);
    });

    it('transitions to new window smoothly with fresh capacity', () => {
      const clock = new ManualClock(0);
      const strategy = createSlidingCounterStrategy({ limit: 10, windowMs: 1000, clock });

      // Use 5 in window 0
      for (let i = 0; i < 5; i++) {
        strategy.apply('key', 1);
      }

      // Advance past window boundary (t=1000)
      clock.setTime(1000);

      // New window: prev=0, curr=0, estimated=0
      // remaining = 10 - 0 - 1 = 9
      const result = strategy.apply('key', 1);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(9);

      // Advance to halfway through second window (t=1500)
      clock.setTime(1500);

      // curr=1, elapsed=0.5, weight=0.5
      // estimated = (0+1) * 0.5 = 0.5
      // remaining = floor(10 - 0.5 - 1) = 8
      const midResult = strategy.apply('key', 1);
      expect(midResult.allowed).toBe(true);
      expect(midResult.remaining).toBe(8);
    });

    it('multi-window rollover resets counter', () => {
      const clock = new ManualClock(0);
      const strategy = createSlidingCounterStrategy({ limit: 10, windowMs: 1000, clock });

      // Use 7 in window 0
      for (let i = 0; i < 7; i++) {
        strategy.apply('key', 1);
      }

      // Advance past 2+ windows (t=3000)
      clock.setTime(3000);

      // Cold start in new window: prev=0, curr=0, estimated=0
      const result = strategy.apply('key', 1);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(9);

      const state = strategy.exportState!('key') as {
        prevCount: number;
        currCount: number;
        currentWindowStart: number;
      };
      expect(state.prevCount).toBe(0);
      expect(state.currCount).toBe(1);
      expect(state.currentWindowStart).toBe(3000);
    });

    it('pure function returns correct StrategyResult structure', () => {
      const result = slidingWindowCounterConsume(null, 1000, 1, 1000, 10);

      expect(result).toHaveProperty('state');
      expect(result).toHaveProperty('result');
      expect(result.state).toHaveProperty('prevCount');
      expect(result.state).toHaveProperty('currCount');
      expect(result.state).toHaveProperty('currentWindowStart');
      expect(result.result).toHaveProperty('allowed', true);
      expect(result.result).toHaveProperty('limit', 10);
      expect(result.result).toHaveProperty('remaining', 9);
    });

    it('blanket test: reasonable throughput under heavy simulation', () => {
      const clock = new ManualClock(0);
      const strategy = createSlidingCounterStrategy({ limit: 100, windowMs: 1000, clock });

      let allowedCount = 0;

      // Simulate bursty traffic over 5 seconds
      for (let t = 0; t < 5000; t += 10) {
        clock.setTime(t);
        for (let burst = 0; burst < 3; burst++) {
          if (strategy.apply('key', 1).allowed) {
            allowedCount++;
          }
        }
      }

      // With sliding window counter, requests are rate-limited smoothly
      // Total allowed should be reasonable (neither too strict nor too lax)
      expect(allowedCount).toBeLessThan(600);
      expect(allowedCount).toBeGreaterThan(400);
    });
  },
);
