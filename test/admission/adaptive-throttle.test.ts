/**
 * Tests for AdaptiveThrottle (Google SRE-style client-side adaptive throttling).
 *
 * All tests use ManualClock for deterministic, instant execution.
 */

import { describe, it, expect } from 'vitest';
import { adaptiveThrottle } from '../../src/admission/adaptive-throttle.js';
import { ManualClock } from '../helpers/manual-clock.js';

describe('adaptiveThrottle', () => {
  it('with k=2 and 100% backend acceptance, drop probability is 0', () => {
    const clock = new ManualClock(1_000_000);
    const throttle = adaptiveThrottle({ k: 2, windowMs: 30_000, clock });

    for (let i = 0; i < 100; i++) {
      throttle.record(true);
    }

    expect(throttle.dropProbability).toBe(0);
  });

  it('with 50% backend acceptance, drop probability stays low (near 0) at k=2', () => {
    const clock = new ManualClock(1_000_000);
    const throttle = adaptiveThrottle({ k: 2, windowMs: 30_000, clock });

    // Accept every other request (50% acceptance)
    for (let i = 0; i < 200; i++) {
      throttle.record(i % 2 === 0);
    }

    // With k=2 and 50% acceptance, drop probability should be near 0
    // p = max(0, (200 - 2*100) / 201) = max(0, 0/201) = 0
    expect(throttle.dropProbability).toBe(0);
  });

  it('with 0% backend acceptance, drop probability approaches 1.0', () => {
    const clock = new ManualClock(1_000_000);
    const throttle = adaptiveThrottle({ k: 2, windowMs: 30_000, clock });

    // All requests rejected
    for (let i = 0; i < 100; i++) {
      throttle.record(false);
    }

    // p = max(0, (100 - 0) / 101) = 100/101 ≈ 0.99
    expect(throttle.dropProbability).toBeGreaterThan(0.9);
  });

  it('window expiry resets counts, drop probability goes to 0', () => {
    const clock = new ManualClock(1_000_000);
    const throttle = adaptiveThrottle({ k: 2, windowMs: 30_000, clock });

    // All requests rejected
    for (let i = 0; i < 100; i++) {
      throttle.record(false);
    }

    expect(throttle.dropProbability).toBeGreaterThan(0.9);

    // Advance clock past window
    clock.advanceBy(30_001);

    // After window expiry, drop probability resets to 0
    expect(throttle.dropProbability).toBe(0);
  });

  it('priority support: high-priority requests shed less than low-priority', () => {
    const clock = new ManualClock(1_000_000);
    const throttle = adaptiveThrottle({ k: 1, windowMs: 60_000, clock });

    // First, feed all rejected to build up drop probability
    for (let i = 0; i < 50; i++) {
      throttle.record(false);
    }

    // Drop probability should be significant now
    const p = throttle.dropProbability;
    expect(p).toBeGreaterThan(0.4);

    // Now simulate request() calls with a deterministic mock for Math.random
    // Use a seeded pseudo-random to get deterministic results
    let highPriorityPassed = 0;
    let lowPriorityPassed = 0;
    const totalSamples = 200;

    // We'll use a simple deterministic approach: test the logic directly
    // by checking that priority=2 has lower effective drop probability than priority=0.5
    // Effective P = p / priority
    const effectivePHigh = p / 2;
    const effectivePLow = p / 0.5; // same as p * 2

    // With high priority, drop probability is halved
    expect(effectivePHigh).toBeLessThan(effectivePLow);

    // Run stochastic test with enough samples
    // Seed the random for deterministic behavior
    let seed = 12345;
    const pseudoRandom = (): number => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };

    // Save original Math.random
    const originalRandom = Math.random;
    Math.random = pseudoRandom;

    try {
      // Create a fresh throttle and build up drop probability
      const clock2 = new ManualClock(1_000_000);
      const throttle2 = adaptiveThrottle({ k: 1, windowMs: 60_000, clock: clock2 });

      for (let i = 0; i < 50; i++) {
        throttle2.record(false);
      }

      for (let i = 0; i < totalSamples; i++) {
        // Alternate high and low priority requests
        if (throttle2.request(2)) highPriorityPassed++;
        if (throttle2.request(0.5)) lowPriorityPassed++;
      }

      // High priority should have a higher pass rate
      expect(highPriorityPassed).toBeGreaterThan(lowPriorityPassed);
    } finally {
      Math.random = originalRandom;
    }
  });

  it('request returns true when drop probability is 0', () => {
    const clock = new ManualClock(1_000_000);
    const throttle = adaptiveThrottle({ k: 2, windowMs: 30_000, clock });

    // All accepted -> p = 0
    for (let i = 0; i < 10; i++) {
      throttle.record(true);
    }

    expect(throttle.dropProbability).toBe(0);

    // Every request should pass
    for (let i = 0; i < 20; i++) {
      expect(throttle.request()).toBe(true);
    }
  });

  it('reset clears all state', () => {
    const clock = new ManualClock(1_000_000);
    const throttle = adaptiveThrottle({ k: 2, windowMs: 30_000, clock });

    // Build up rejections
    for (let i = 0; i < 100; i++) {
      throttle.record(false);
    }

    expect(throttle.dropProbability).toBeGreaterThan(0.9);

    throttle.reset();

    expect(throttle.dropProbability).toBe(0);
    expect(throttle.request()).toBe(true);
  });
});
