import { describe, it, expect } from 'vitest';
import { ManualClock } from '../helpers/manual-clock.js';
import {
  mergeableSketch,
  sketchSnapshotFromBytes,
} from '../../src/sketch/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function request(
  limiter: ReturnType<typeof mergeableSketch>,
  key: string,
) {
  return limiter.checkSync(key);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MergeableSketch', () => {
  describe('merge() combines two sketches correctly', () => {
    it('merged sketch estimate reflects combined counts', () => {
      const clock = new ManualClock(0);

      const sketchA = mergeableSketch({ limit: 100, windowMs: 10000, clock });
      const sketchB = mergeableSketch({ limit: 100, windowMs: 10000, clock });

      // Send 3 requests to sketch A for same key
      for (let i = 0; i < 3; i++) {
        request(sketchA, 'shared:key');
      }

      // Send 4 requests to sketch B for same key
      for (let i = 0; i < 4; i++) {
        request(sketchB, 'shared:key');
      }

      // Merge B into A
      sketchA.merge(sketchB.snapshot());

      // Verify estimate reflects at least 7 requests.
      // checkSync also increments by 1, so total count >= 8.
      // With limit=100, remaining <= 92.
      const estimate = sketchA.checkSync('shared:key');
      expect(estimate.remaining).toBeLessThanOrEqual(92);
    });

    it('merge does not mutate the source snapshot', () => {
      const clock = new ManualClock(0);

      const sketchA = mergeableSketch({ limit: 100, windowMs: 10000, clock });
      const sketchB = mergeableSketch({ limit: 100, windowMs: 10000, clock });

      for (let i = 0; i < 3; i++) {
        request(sketchA, 'key:x');
      }
      for (let i = 0; i < 5; i++) {
        request(sketchB, 'key:x');
      }

      const snapshot = sketchB.snapshot();
      const countersBefore = snapshot.counters.slice();

      sketchA.merge(snapshot);

      // Snapshot counters should be unchanged
      expect(snapshot.counters).toEqual(countersBefore);
    });
  });

  describe('snapshot/toBytes/fromBytes roundtrip', () => {
    it('roundtrip preserves counters', () => {
      const clock = new ManualClock(0);

      const original = mergeableSketch({
        limit: 50,
        windowMs: 10000,
        clock,
      });

      // Make some requests
      for (let i = 0; i < 7; i++) {
        request(original, 'roundtrip:key');
      }
      for (let i = 0; i < 3; i++) {
        request(original, 'other:key');
      }

      // Snapshot roundtrip
      const snapshot = original.snapshot();
      const bytes = original.toBytes();
      const restored = sketchSnapshotFromBytes(
        bytes,
        snapshot.width,
        snapshot.depth,
      );
      restored.windowStart = snapshot.windowStart;

      // Create a new mergeable sketch with the restored counters
      const restoredSketch = mergeableSketch({
        limit: 50,
        windowMs: 10000,
        clock,
      });
      restoredSketch.merge(restored);

      // Verify counters match exactly
      const originalSnapshot = original.snapshot();
      const restoredSnapshot = restoredSketch.snapshot();
      expect(restoredSnapshot.counters).toEqual(originalSnapshot.counters);
    });

    it('toBytes produces correct length', () => {
      const clock = new ManualClock(0);
      const sketch = mergeableSketch({ limit: 10, windowMs: 1000, clock });

      const snapshot = sketch.snapshot();
      const bytes = sketch.toBytes();

      expect(bytes.length).toBe(snapshot.width * snapshot.depth * 4);
    });

    it('sketchSnapshotFromBytes validates byte length', () => {
      const tooShort = new Uint8Array(10);
      expect(() => sketchSnapshotFromBytes(tooShort, 10, 10)).toThrow(
        'Invalid byte length',
      );
    });

    it('restored snapshot counters match original', () => {
      const clock = new ManualClock(0);
      const sketch = mergeableSketch({ limit: 10, windowMs: 1000, clock });

      for (let i = 0; i < 4; i++) {
        request(sketch, 'test:key');
      }

      const bytes = sketch.toBytes();
      const snapshot = sketch.snapshot();
      const restored = sketchSnapshotFromBytes(
        bytes,
        snapshot.width,
        snapshot.depth,
      );

      expect(restored.counters).toEqual(snapshot.counters);
    });
  });

  describe('after merge, estimate reflects combined counts for multiple keys', () => {
    it('estimates for both keys reflect merged counts', () => {
      const clock = new ManualClock(0);

      const sketchA = mergeableSketch({
        limit: 100,
        windowMs: 10000,
        clock,
      });
      const sketchB = mergeableSketch({
        limit: 100,
        windowMs: 10000,
        clock,
      });

      // Send requests to A for key1 and key2
      for (let i = 0; i < 5; i++) {
        request(sketchA, 'key:one');
      }
      for (let i = 0; i < 3; i++) {
        request(sketchA, 'key:two');
      }

      // Send requests to B for key1 and key2
      for (let i = 0; i < 2; i++) {
        request(sketchB, 'key:one');
      }
      for (let i = 0; i < 4; i++) {
        request(sketchB, 'key:two');
      }

      // Merge B into A
      sketchA.merge(sketchB.snapshot());

      // key:one has at least 5+2 = 7 requests.
      // checkSync adds 1, so total >= 8. Remaining <= 92.
      const resultOne = sketchA.checkSync('key:one');
      expect(resultOne.remaining).toBeLessThanOrEqual(92);

      // key:two has at least 3+4 = 7 requests.
      // checkSync adds 1, so total >= 8. Remaining <= 92.
      const resultTwo = sketchA.checkSync('key:two');
      expect(resultTwo.remaining).toBeLessThanOrEqual(92);
    });
  });

  describe('merged sketch never over-admits', () => {
    it('over-admit property holds after merge', () => {
      const clock = new ManualClock(0);
      const limit = 5;

      const sketchA = mergeableSketch({ limit, windowMs: 10000, clock });
      const sketchB = mergeableSketch({ limit, windowMs: 10000, clock });

      // Heavily use sketchB for a key
      for (let i = 0; i < 20; i++) {
        request(sketchB, 'shared:key');
      }

      // Merge the heavily used sketch into fresh sketchA
      sketchA.merge(sketchB.snapshot());

      // Now try to admit more through sketchA
      const totalRequests = limit + 100;
      let allowed = 0;

      for (let i = 0; i < totalRequests; i++) {
        if (request(sketchA, 'shared:key').allowed) {
          allowed++;
        }
      }

      // sketchA should not allow more than limit requests
      expect(allowed).toBeLessThanOrEqual(limit);
    });

    it('merge of empty sketch preserves counters', () => {
      const clock = new ManualClock(0);
      const sketchA = mergeableSketch({ limit: 10, windowMs: 1000, clock });
      const emptySketch = mergeableSketch({
        limit: 10,
        windowMs: 1000,
        clock,
      });

      // Use sketchA
      for (let i = 0; i < 5; i++) {
        request(sketchA, 'key:x');
      }

      const countersBefore = sketchA.snapshot().counters;

      // Merge empty sketch (should be a no-op)
      sketchA.merge(emptySketch.snapshot());

      const countersAfter = sketchA.snapshot().counters;

      // Counters should be unchanged by merging an empty sketch
      expect(countersAfter).toEqual(countersBefore);
    });
  });

  describe('snapshot', () => {
    it('snapshot returns correct structure', () => {
      const clock = new ManualClock(0);
      const sketch = mergeableSketch({ limit: 10, windowMs: 1000, clock });

      const snapshot = sketch.snapshot();

      expect(snapshot).toHaveProperty('counters');
      expect(snapshot).toHaveProperty('width');
      expect(snapshot).toHaveProperty('depth');
      expect(snapshot).toHaveProperty('windowStart');
      expect(snapshot.counters).toBeInstanceOf(Uint32Array);
      expect(snapshot.width).toBeGreaterThan(0);
      expect(snapshot.depth).toBeGreaterThan(0);
    });

    it('snapshot returns a copy (modifying snapshot does not affect original)', () => {
      const clock = new ManualClock(0);
      const sketch = mergeableSketch({ limit: 10, windowMs: 1000, clock });

      // 1 request → estimate >= 1 → remaining = 10 - (>=1) = <=9
      request(sketch, 'test:key');

      const snapshot = sketch.snapshot();
      const counterCount = snapshot.counters.length;

      // Mutate snapshot counters
      for (let i = 0; i < counterCount; i++) {
        snapshot.counters[i] = 999;
      }

      // Original sketch should be unaffected.
      // checkSync adds 1 more, so total >= 2, remaining <= 8
      const result = sketch.checkSync('test:key');
      expect(result.remaining).toBeLessThanOrEqual(8);
    });
  });

  describe('checkSync, check, reset', () => {
    it('checkSync works after merge', () => {
      const clock = new ManualClock(0);
      const sketchA = mergeableSketch({ limit: 10, windowMs: 1000, clock });
      const sketchB = mergeableSketch({ limit: 10, windowMs: 1000, clock });

      request(sketchA, 'key:1');
      request(sketchB, 'key:1');

      sketchA.merge(sketchB.snapshot());

      // At least 2 requests, checkSync adds 1, so total >= 3, remaining <= 7
      expect(sketchA.checkSync('key:1').remaining).toBeLessThanOrEqual(7);
    });

    it('check works after merge', async () => {
      const clock = new ManualClock(0);
      const sketchA = mergeableSketch({ limit: 10, windowMs: 1000, clock });
      const sketchB = mergeableSketch({ limit: 10, windowMs: 1000, clock });

      request(sketchA, 'key:1');
      request(sketchB, 'key:1');

      sketchA.merge(sketchB.snapshot());

      const result = await sketchA.check('key:1');
      expect(result.remaining).toBeLessThanOrEqual(7);
    });

    it('reset clears merged counters', () => {
      const clock = new ManualClock(0);
      const sketchA = mergeableSketch({ limit: 10, windowMs: 1000, clock });
      const sketchB = mergeableSketch({ limit: 10, windowMs: 1000, clock });

      for (let i = 0; i < 5; i++) {
        request(sketchA, 'key:x');
      }
      for (let i = 0; i < 3; i++) {
        request(sketchB, 'key:x');
      }

      sketchA.merge(sketchB.snapshot());
      sketchA.reset();

      // After reset, should have full capacity.
      // First checkSync: allowed=true, remaining=9 (10-1 from checkSync)
      const firstResult = sketchA.checkSync('key:x');
      expect(firstResult.allowed).toBe(true);
      expect(firstResult.remaining).toBe(9);
    });
  });
});
