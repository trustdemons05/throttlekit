/**
 * Parameterized store contract tests.
 *
 * Any Store implementation can be added to the `stores` array and will be
 * validated against the shared contract.
 */

import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../../src/stores/memory-store.js';
import { ManualClock } from '../helpers/manual-clock.js';
import type { Store } from '../../src/core/types.js';

// ---------------------------------------------------------------------------
// Store implementations under test
// ---------------------------------------------------------------------------

const stores: Array<[string, () => Store]> = [
  ['MemoryStore', () => new MemoryStore({ clock: new ManualClock(1_000_000_000_000) })],
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface NumState {
  n: number;
}

/** Assert that the store has get/set/delete methods (guards for optional Store methods) */
function assertStoreHasGetSetDelete(
  store: Store,
): asserts store is Store & { get: NonNullable<Store['get']>; set: NonNullable<Store['set']>; delete: NonNullable<Store['delete']> } {
  if (!store.get || !store.set || !store.delete) {
    throw new Error('Store must implement get/set/delete for contract tests');
  }
}

// ---------------------------------------------------------------------------
// Contract tests
// ---------------------------------------------------------------------------

describe('Store contract', () => {
  it.each(stores)('%s: get returns set value', async (_name, factory) => {
    const store = factory();
    assertStoreHasGetSetDelete(store);
    await store.set('key', 'hello');
    const result = await store.get<string>('key');
    expect(result).toBe('hello');
  });

  it.each(stores)('%s: get returns null for missing key', async (_name, factory) => {
    const store = factory();
    assertStoreHasGetSetDelete(store);
    const result = await store.get<unknown>('missing');
    expect(result).toBeNull();
  });

  it.each(stores)('%s: delete removes a key', async (_name, factory) => {
    const store = factory();
    assertStoreHasGetSetDelete(store);
    await store.set('key', 'value');
    await store.delete('key');
    const result = await store.get<string>('key');
    expect(result).toBeNull();
  });

  it.each(stores)('%s: apply is atomic (per-key mutex)', async (_name, factory) => {
    const store = factory();

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        store.apply<NumState, number>('atomic-key', 60_000, (prev) => {
          const state: NumState = { n: (prev?.n ?? 0) + 1 };
          return { state, result: state.n };
        }),
      ),
    );

    // All 50 should complete without overlap
    expect(results.sort((a, b) => a - b)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 1),
    );
  });

  it.each(stores)('%s: apply reads existing state', async (_name, factory) => {
    const store = factory();
    assertStoreHasGetSetDelete(store);
    await store.set<NumState>('existing', { n: 10 });

    const result = await store.apply<NumState, number>('existing', 60_000, (prev) => {
      const state: NumState = { n: (prev?.n ?? 0) + 1 };
      return { state, result: state.n };
    });

    expect(result).toBe(11);
  });

  it.each(stores)('%s: set/get/delete with various value types', async (_name, factory) => {
    const store = factory();
    assertStoreHasGetSetDelete(store);

    // Object
    await store.set('obj', { a: 1, b: 'two' });
    expect(await store.get<{ a: number; b: string }>('obj')).toEqual({ a: 1, b: 'two' });

    // Array
    await store.set('arr', [1, 2, 3]);
    expect(await store.get<number[]>('arr')).toEqual([1, 2, 3]);

    // String
    await store.set('str', 'test');
    expect(await store.get<string>('str')).toBe('test');

    // Number
    await store.set('num', 42);
    expect(await store.get<number>('num')).toBe(42);

    // Boolean
    await store.set('bool', true);
    expect(await store.get<boolean>('bool')).toBe(true);

    // Null value (should be stored, not missing)
    await store.set('null-val', null);
    expect(await store.get<null>('null-val')).toBeNull();
  });
});
