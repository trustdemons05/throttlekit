/**
 * Tests for FairShareLimiter (per-tenant fair division rate limiter).
 *
 * All tests use ManualClock for deterministic, instant execution.
 */

import { describe, it, expect } from 'vitest';
import { fairShare } from '../../src/admission/fair-share.js';
import { ManualClock } from '../helpers/manual-clock.js';

describe('fairShare', () => {
  it('2 tenants with limit=100: each gets exactly 50 with alternating checks', () => {
    const clock = new ManualClock(1_000_000);
    const limiter = fairShare({ limit: 100, windowMs: 60_000, clock });

    let allowedA = 0;
    let allowedB = 0;

    // Alternate between tenant A and B
    for (let i = 0; i < 200; i++) {
      const tenant = i % 2 === 0 ? 'A' : 'B';
      const result = limiter.checkSync(tenant);
      if (result.allowed) {
        if (tenant === 'A') allowedA++;
        else allowedB++;
      }
    }

    // Each should get exactly 50 (100/2)
    expect(allowedA).toBe(50);
    expect(allowedB).toBe(50);
  });

  it('1 active tenant gets full limit', () => {
    const clock = new ManualClock(1_000_000);
    const limiter = fairShare({ limit: 100, windowMs: 60_000, clock });

    let allowed = 0;
    let denied = 0;

    for (let i = 0; i < 150; i++) {
      const result = limiter.checkSync('A');
      if (result.allowed) allowed++;
      else denied++;
    }

    expect(allowed).toBe(100);
    expect(denied).toBe(50);
  });

  it('3 tenants, one idle: idle share redistributed to active two', () => {
    const clock = new ManualClock(1_000_000);
    const limiter = fairShare({ limit: 90, windowMs: 60_000, clock });

    let allowedA = 0;
    let allowedB = 0;

    // Only check tenants A and B, never C
    for (let i = 0; i < 100; i++) {
      let result = limiter.checkSync('A');
      if (result.allowed) allowedA++;
      result = limiter.checkSync('B');
      if (result.allowed) allowedB++;
    }

    // Each gets roughly 45 (90/2)
    expect(allowedA).toBe(45);
    expect(allowedB).toBe(45);
  });

  it('window rotation resets counts', () => {
    const clock = new ManualClock(1_000_000);
    const limiter = fairShare({ limit: 10, windowMs: 60_000, clock });

    // Exhaust tenant A
    for (let i = 0; i < 10; i++) {
      const result = limiter.checkSync('A');
      expect(result.allowed).toBe(true);
    }

    // Tenant A should be denied now
    expect(limiter.checkSync('A').allowed).toBe(false);

    // Advance clock past window
    clock.advanceBy(60_001);

    // Tenant A should get fresh capacity
    const result = limiter.checkSync('A');
    expect(result.allowed).toBe(true);
  });

  it('global total never exceeds limit', () => {
    const clock = new ManualClock(1_000_000);
    const limiter = fairShare({ limit: 50, windowMs: 60_000, clock });

    let totalAllowed = 0;

    // Mix of tenants
    const tenants = ['A', 'B', 'C', 'D', 'E'];

    for (let i = 0; i < 200; i++) {
      const tenant = tenants[i % tenants.length]!;
      const result = limiter.checkSync(tenant);
      if (result.allowed) totalAllowed++;
    }

    // Global total should never exceed limit
    expect(totalAllowed).toBeLessThanOrEqual(50);
  });

  it('check() async wrapper works', async () => {
    const clock = new ManualClock(1_000_000);
    const limiter = fairShare({ limit: 10, windowMs: 60_000, clock });

    const result = await limiter.check('A');
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(10);
  });

  it('reset clears all state', () => {
    const clock = new ManualClock(1_000_000);
    const limiter = fairShare({ limit: 10, windowMs: 60_000, clock });

    // Exhaust
    for (let i = 0; i < 10; i++) {
      limiter.checkSync('A');
    }
    expect(limiter.checkSync('A').allowed).toBe(false);

    limiter.reset();

    // Should have fresh capacity
    expect(limiter.checkSync('A').allowed).toBe(true);
  });
});
