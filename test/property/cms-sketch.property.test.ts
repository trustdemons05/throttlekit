import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { CountMinSketch } from '../../src/sketch/cms.js';

describe('Count-Min Sketch Properties', () => {
  it('estimate is monotonic for the same key', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 10 }),
        fc.array(fc.integer({ min: 1, max: 10 }), {
          minLength: 1,
          maxLength: 50,
        }),
        (key, counts) => {
          const sketch = new CountMinSketch(1000, 5);

          let prevEstimate = sketch.estimate(key);
          for (let i = 0; i < counts.length; i++) {
            const count = counts[i]!;
            sketch.increment(key, count);
            const newEstimate = sketch.estimate(key);

            // Monotonicity: estimate never decreases after increment
            expect(newEstimate).toBeGreaterThanOrEqual(prevEstimate);
            prevEstimate = newEstimate;
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('error is bounded by epsilon * total with high probability', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 10 }), {
          minLength: 1,
          maxLength: 10,
        }),
        fc.array(fc.integer({ min: 1, max: 20 }), {
          minLength: 1,
          maxLength: 100,
        }),
        (keys, counts) => {
          const width = 1000;
          const depth = 5;
          const epsilon = 2 / width;
          const sketch = new CountMinSketch(width, depth);
          const trueCounts = new Map<string, number>();
          let total = 0;

          for (let i = 0; i < counts.length; i++) {
            const key = keys[i % keys.length]!;
            const count = counts[i]!;
            sketch.increment(key, count);
            trueCounts.set(key, (trueCounts.get(key) ?? 0) + count);
            total += count;
          }

          for (const [key, trueCount] of trueCounts) {
            const estimate = sketch.estimate(key);
            const error = estimate - trueCount;
            // Probabilistic bound: with probability 1-delta, error <= epsilon * total
            // Conservative update can under-estimate with multiple keys;
            // only the upper bound is probabilistically guaranteed.
            expect(error).toBeLessThanOrEqual(epsilon * total + 1);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('merge preserves total counter mass', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 10 }), {
          minLength: 1,
          maxLength: 10,
        }),
        fc.array(fc.integer({ min: 1, max: 20 }), {
          minLength: 1,
          maxLength: 50,
        }),
        fc.array(fc.integer({ min: 1, max: 20 }), {
          minLength: 1,
          maxLength: 50,
        }),
        (keys, countsA, countsB) => {
          const sketchA = new CountMinSketch(1000, 5);
          const sketchB = new CountMinSketch(1000, 5);

          for (let i = 0; i < countsA.length; i++) {
            sketchA.increment(keys[i % keys.length]!, countsA[i]!);
          }
          for (let i = 0; i < countsB.length; i++) {
            sketchB.increment(keys[i % keys.length]!, countsB[i]!);
          }

          const merged = new CountMinSketch(1000, 5);
          merged.merge(sketchA);
          merged.merge(sketchB);

          // Conservative update means individual estimates may not sum exactly,
          // but the total counter mass should be preserved
          const totalA = sketchA.snapshot().reduce((a, b) => a + b, 0);
          const totalB = sketchB.snapshot().reduce((a, b) => a + b, 0);
          const totalMerged = merged.snapshot().reduce((a, b) => a + b, 0);
          expect(totalMerged).toBe(totalA + totalB);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('reset zeros all counters', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 10 }), {
          minLength: 1,
          maxLength: 10,
        }),
        fc.array(fc.integer({ min: 1, max: 20 }), {
          minLength: 1,
          maxLength: 50,
        }),
        (keys, counts) => {
          const sketch = new CountMinSketch(1000, 5);

          for (let i = 0; i < counts.length; i++) {
            sketch.increment(keys[i % keys.length]!, counts[i]!);
          }

          sketch.reset();

          for (const key of keys) {
            expect(sketch.estimate(key)).toBe(0);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
