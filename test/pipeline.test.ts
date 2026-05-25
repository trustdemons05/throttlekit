import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { ManualClock } from '../src/core/clock.js';

describe('Pipeline verification', () => {
  it('ManualClock advances correctly', () => {
    const clock = new ManualClock(1000);
    clock.advanceBy(500);
    expect(clock.now()).toBe(1500);
  });

  it('addition is commutative (fast-check)', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => a + b === b + a)
    );
  });
});
