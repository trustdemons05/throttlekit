import { describe, it, expect } from 'vitest';
import { SpaceSaving } from '../../src/analytics/space-saving.js';

describe('SpaceSaving', () => {
  it('tracks top-K most frequent items', () => {
    const ss = new SpaceSaving<number>(3);

    // 1 appears 5 times, 2 appears 3 times, 3 appears 2 times
    for (let i = 0; i < 5; i++) ss.observe(1);
    for (let i = 0; i < 3; i++) ss.observe(2);
    for (let i = 0; i < 2; i++) ss.observe(3);

    const top = ss.topK();
    expect(top).toHaveLength(3);
    expect(top[0]).toMatchObject({ item: 1, count: 5, error: 0 });
    expect(top[1]).toMatchObject({ item: 2, count: 3, error: 0 });
    expect(top[2]).toMatchObject({ item: 3, count: 2, error: 0 });
  });

  it('handles k=1 (tracks single most frequent)', () => {
    const ss = new SpaceSaving<string>(1);

    // With k=1, every new distinct item replaces the previous one
    // because only 1 slot is available
    ss.observe('a');   // a: count=1
    ss.observe('b');   // b replaces a: b.count=2, b.error=1
    ss.observe('a');   // a replaces b: a.count=3, a.error=2
    ss.observe('c');   // c replaces a: c.count=4, c.error=3

    const top = ss.topK();
    expect(top).toHaveLength(1);
    // Only 'c' remains (the last observed item), with count=4
    expect(top[0]!.item).toBe('c');
    expect(top[0]!.count).toBe(4);
  });

  it('never tracks more than k items', () => {
    const ss = new SpaceSaving<string>(3);

    // Observe 5 distinct items
    ss.observe('a');
    ss.observe('b');
    ss.observe('c');
    ss.observe('d');
    ss.observe('e');

    const top = ss.topK();
    expect(top.length).toBeLessThanOrEqual(3);
  });

  it('correctly replaces minimum-count item', () => {
    const ss = new SpaceSaving<string>(3);

    ss.observe('a');
    ss.observe('b');
    ss.observe('c');
    // At this point: a=1, b=1, c=1 (all counts equal)
    // Now 'd' replaces the min-count item (e.g., 'a')
    ss.observe('d');

    const top = ss.topK();
    // Items: d (count=2), b (count=1), c (count=1)
    // Our replacement picked 'a' (count=1) -> d gets count=2
    const dEntry = top.find(e => e.item === 'd');
    expect(dEntry).toBeDefined();
    expect(dEntry!.count).toBe(2);
    expect(dEntry!.error).toBe(1);
  });

  it('reset clears all state', () => {
    const ss = new SpaceSaving<number>(3);

    ss.observe(1);
    ss.observe(2);
    ss.observe(3);

    expect(ss.topK()).toHaveLength(3);

    ss.reset();
    expect(ss.topK()).toHaveLength(0);
  });

  it('throws for k < 1', () => {
    expect(() => new SpaceSaving(0)).toThrow('k must be at least 1');
  });
});