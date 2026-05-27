/**
 * Tests for weighted fair share limiter and weightedMaxMin batch allocator.
 *
 * All tests use ManualClock for deterministic, instant execution.
 */

import { describe, it, expect } from 'vitest';
import { weightedFairShare, weightedMaxMin } from '../../src/admission/weighted.js';
import { ManualClock } from '../helpers/manual-clock.js';

describe('weightedMaxMin', () => {
  it('weightedMaxMin([100,100,100,100], [4,1,1,1], 100) → approximately [57,15,14,14]', () => {
    const result = weightedMaxMin([100, 100, 100, 100], [4, 1, 1, 1], 100);

    // Sum must equal budget
    const sum = result.reduce((s, v) => s + v, 0);
    expect(sum).toBe(100);

    // 4/7 of 100 ≈ 57.14 → ~57 (after integer rounding)
    // Each of the weight-1 tenants: 1/7 of 100 ≈ 14.29 → ~14 or 15
    expect(result[0]).toBeGreaterThanOrEqual(56);
    expect(result[0]).toBeLessThanOrEqual(58);
    expect(result[1]).toBeGreaterThanOrEqual(13);
    expect(result[1]).toBeLessThanOrEqual(16);
    expect(result[2]).toBeGreaterThanOrEqual(13);
    expect(result[2]).toBeLessThanOrEqual(16);
    expect(result[3]).toBeGreaterThanOrEqual(13);
    expect(result[3]).toBeLessThanOrEqual(16);
  });

  it('equal weights = equal shares', () => {
    const result = weightedMaxMin([50, 50, 50], [1, 1, 1], 100);

    const sum = result.reduce((s, v) => s + v, 0);
    expect(sum).toBe(100);

    // With equal weights, demand 50, budget 100, each gets ~33.33
    expect(result[0]).toBeGreaterThanOrEqual(32);
    expect(result[0]).toBeLessThanOrEqual(35);
    expect(result[1]).toBeGreaterThanOrEqual(32);
    expect(result[1]).toBeLessThanOrEqual(35);
    expect(result[2]).toBeGreaterThanOrEqual(32);
    expect(result[2]).toBeLessThanOrEqual(35);
  });

  it('zero demand = zero allocation, share redistributed', () => {
    const result = weightedMaxMin([0, 100], [1, 1], 100);

    expect(result[0]).toBe(0);
    expect(result[1]).toBe(100);
    expect(result.reduce((s, v) => s + v, 0)).toBe(100);
  });

  it('budget > total demand: each tenant gets exactly their demand', () => {
    const result = weightedMaxMin([10, 20, 30], [1, 1, 1], 100);

    // Total demand = 60, budget = 100
    expect(result).toEqual([10, 20, 30]);
    expect(result.reduce((s, v) => s + v, 0)).toBe(60);
  });

  it('handles empty inputs', () => {
    const result = weightedMaxMin([], [], 100);
    expect(result).toEqual([]);
  });

  it('handles zero budget', () => {
    const result = weightedMaxMin([100, 100], [1, 1], 0);
    expect(result).toEqual([0, 0]);
  });

  it('handles all zero weights', () => {
    const result = weightedMaxMin([100, 100], [0, 0], 50);
    expect(result).toEqual([0, 0]);
  });

  it('handles single tenant', () => {
    const result = weightedMaxMin([50], [2], 30);
    expect(result).toEqual([30]);
  });
});

describe('weightedFairShare (online limiter)', () => {
  it('weighted tenant gets proportionally more', () => {
    const clock = new ManualClock(1_000_000);
    const limiter = weightedFairShare({
      limit: 90,
      windowMs: 60_000,
      weightOf: (id: string) => (id === 'A' ? 2 : 1),
      clock,
    });

    let allowedA = 0;
    let allowedB = 0;

    // Check A and B alternately
    for (let i = 0; i < 120; i++) {
      const tenant = i % 2 === 0 ? 'A' : 'B';
      const result = limiter.checkSync(tenant);
      if (result.allowed) {
        if (tenant === 'A') allowedA++;
        else allowedB++;
      }
    }

    // A has weight 2, B has weight 1
    // Total weight with both active = 3
    // A gets ~2/3 of 90 = 60, B gets ~1/3 of 90 = 30
    expect(allowedA).toBeGreaterThan(allowedB);

    // A should get approximately 60, B approximately 30
    expect(allowedA).toBeGreaterThanOrEqual(55);
    expect(allowedA).toBeLessThanOrEqual(65);
    expect(allowedB).toBeGreaterThanOrEqual(25);
    expect(allowedB).toBeLessThanOrEqual(35);

    // Global total should not exceed limit
    expect(allowedA + allowedB).toBeLessThanOrEqual(90);
  });

  it('single tenant gets full limit', () => {
    const clock = new ManualClock(1_000_000);
    const limiter = weightedFairShare({
      limit: 50,
      windowMs: 60_000,
      weightOf: () => 1,
      clock,
    });

    let allowed = 0;
    for (let i = 0; i < 60; i++) {
      const result = limiter.checkSync('A');
      if (result.allowed) allowed++;
    }

    expect(allowed).toBe(50);
  });

  it('window rotation resets counts', () => {
    const clock = new ManualClock(1_000_000);
    const limiter = weightedFairShare({
      limit: 10,
      windowMs: 60_000,
      weightOf: () => 1,
      clock,
    });

    // Exhaust tenant A
    for (let i = 0; i < 10; i++) {
      limiter.checkSync('A');
    }
    expect(limiter.checkSync('A').allowed).toBe(false);

    // Advance past window
    clock.advanceBy(60_001);

    expect(limiter.checkSync('A').allowed).toBe(true);
  });

  it('check() async wrapper works', async () => {
    const clock = new ManualClock(1_000_000);
    const limiter = weightedFairShare({
      limit: 10,
      windowMs: 60_000,
      weightOf: () => 1,
      clock,
    });

    const result = await limiter.check('A');
    expect(result.allowed).toBe(true);
  });

  it('reset clears all state', () => {
    const clock = new ManualClock(1_000_000);
    const limiter = weightedFairShare({
      limit: 10,
      windowMs: 60_000,
      weightOf: () => 1,
      clock,
    });

    for (let i = 0; i < 10; i++) {
      limiter.checkSync('A');
    }
    expect(limiter.checkSync('A').allowed).toBe(false);

    limiter.reset();
    expect(limiter.checkSync('A').allowed).toBe(true);
  });
});
