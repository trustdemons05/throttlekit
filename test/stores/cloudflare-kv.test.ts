/**
 * Tests for KVStore (Cloudflare KV-backed store).
 *
 * Uses an in-memory mock of KVNamespace so tests run in Node.js
 * without any Cloudflare SDK dependency.
 */

import { describe, it, expect, vi } from 'vitest';
import { KVStore, KV_CONSISTENCY_WARNING } from '../../src/stores/cloudflare-kv.js';
import type { KVNamespace } from '../../src/stores/cloudflare-kv.js';

// ---------------------------------------------------------------------------
// Mock implementations
// ---------------------------------------------------------------------------

interface PutCall {
  key: string;
  value: string;
  options: { expirationTtl?: number } | undefined;
}

class MockKVNamespace implements KVNamespace {
  private data = new Map<string, string>();
  public putCalls: PutCall[] = [];

  async get(key: string, _options?: { type?: 'text' | 'json' }): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.data.set(key, value);
    this.putCalls.push({ key, value, options });
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  /** Reset all stored data and call history. */
  clear(): void {
    this.data.clear();
    this.putCalls = [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CounterState {
  count: number;
}

function lastPut(kv: MockKVNamespace): PutCall | undefined {
  return kv.putCalls[kv.putCalls.length - 1];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('KVStore', () => {
  describe('get', () => {
    it('returns null for missing key', async () => {
      const kv = new MockKVNamespace();
      const store = new KVStore({ kv });

      const result = await store.get<unknown>('missing');
      expect(result).toBeNull();
    });
  });

  describe('set and get', () => {
    it('set stores a value and get retrieves it', async () => {
      const kv = new MockKVNamespace();
      const store = new KVStore({ kv });

      await store.set('key', { value: 42 });
      const result = await store.get<{ value: number }>('key');
      expect(result).toEqual({ value: 42 });
    });
  });

  describe('delete', () => {
    it('delete removes a key', async () => {
      const kv = new MockKVNamespace();
      const store = new KVStore({ kv });

      await store.set('key', 'value');
      await store.delete('key');
      const result = await store.get<string>('key');
      expect(result).toBeNull();
    });
  });

  describe('apply', () => {
    it('creates new entry if none exists', async () => {
      const kv = new MockKVNamespace();
      const store = new KVStore({ kv });

      const result = await store.apply<CounterState, boolean>('new-key', 60_000, (prev) => {
        const state: CounterState = { count: (prev?.count ?? 0) + 1 };
        return { state, result: true };
      });

      expect(result).toBe(true);
      const stored = await store.get<CounterState>('new-key');
      expect(stored).toEqual({ count: 1 });
    });

    it('reads existing state and transforms it', async () => {
      const kv = new MockKVNamespace();
      const store = new KVStore({ kv });

      await store.set('counter', { count: 10 });

      const result = await store.apply<CounterState, number>('counter', 60_000, (prev) => {
        const state: CounterState = { count: (prev?.count ?? 0) + 1 };
        return { state, result: state.count };
      });

      expect(result).toBe(11);
    });
  });

  describe('TTL passthrough', () => {
    it('apply passes TTL as expirationTtl in seconds', async () => {
      const kv = new MockKVNamespace();
      const store = new KVStore({ kv });

      await store.apply<CounterState, boolean>('ttl-key', 5000, (prev) => {
        const state: CounterState = { count: (prev?.count ?? 0) + 1 };
        return { state, result: true };
      });

      const call = lastPut(kv);
      expect(call?.options?.expirationTtl).toBe(5);
    });

    it('set with ttlMs passes correct expirationTtl', async () => {
      const kv = new MockKVNamespace();
      const store = new KVStore({ kv });

      await store.set('ttl-key', 'value', 10000);

      const call = lastPut(kv);
      expect(call?.options?.expirationTtl).toBe(10);
    });

    it('set without ttlMs does not pass expirationTtl', async () => {
      const kv = new MockKVNamespace();
      const store = new KVStore({ kv });

      await store.set('no-ttl', 'value');

      const call = lastPut(kv);
      expect(call?.options).toBeUndefined();
    });
  });

  describe('prefix isolation', () => {
    it('prefix isolation works correctly', async () => {
      const kv = new MockKVNamespace();
      const storeA = new KVStore({ kv, prefix: 'app1:' });
      const storeB = new KVStore({ kv, prefix: 'app2:' });

      await storeA.set('same-key', 'value-a');
      await storeB.set('same-key', 'value-b');

      const resultA = await storeA.get<string>('same-key');
      const resultB = await storeB.get<string>('same-key');

      expect(resultA).toBe('value-a');
      expect(resultB).toBe('value-b');
    });

    it('same prefix accesses same data', async () => {
      const kv = new MockKVNamespace();
      const store1 = new KVStore({ kv, prefix: 'shared:' });
      const store2 = new KVStore({ kv, prefix: 'shared:' });

      await store1.set('data', { x: 1 });
      const result = await store2.get<{ x: number }>('data');
      expect(result).toEqual({ x: 1 });
    });

    it('empty prefix is default', async () => {
      const kv = new MockKVNamespace();
      const store = new KVStore({ kv });

      await store.set('key', 'default-prefix');
      const result = await store.get<string>('key');
      expect(result).toBe('default-prefix');
    });
  });

  describe('consistencyWarning option', () => {
    it('consistencyWarning option exists and can be set', () => {
      const kv = new MockKVNamespace();

      // Should not throw with consistencyWarning: false
      const store1 = new KVStore({ kv, consistencyWarning: false });
      expect(store1).toBeInstanceOf(KVStore);

      // Should not throw with consistencyWarning: true
      const store2 = new KVStore({ kv, consistencyWarning: true });
      expect(store2).toBeInstanceOf(KVStore);

      // Should not throw without consistencyWarning (defaults)
      const store3 = new KVStore({ kv });
      expect(store3).toBeInstanceOf(KVStore);
    });
  });

  describe('write cache avoids self-stale reads', () => {
    it('local write cache avoids self-stale reads', async () => {
      // Mock KV where get() returns stale data (simulates eventual consistency)
      let kvData = new Map<string, string>();
      const kv: KVNamespace = {
        get: vi.fn(async (key: string) => kvData.get(key) ?? null),
        put: vi.fn(async (key: string, value: string) => {
          // Intentionally do NOT update kvData immediately — simulate stale read
          // The value should come from the local cache instead
        }),
        delete: vi.fn(async (key: string) => { kvData.delete(key); }),
      };

      const store = new KVStore({ kv, consistencyWarning: false });

      // Write via apply — this should cache the value locally
      const result = await store.apply<{ val: number }, number>('stale-test', 60_000, (prev) => {
        const state = { val: (prev?.val ?? 0) + 1 };
        return { state, result: state.val };
      });
      expect(result).toBe(1);

      // Manually verify the cache hit: even though kvData is empty (simulating stale read),
      // the get() should return the cached value
      const cached = await store.get<{ val: number }>('stale-test');
      expect(cached).toEqual({ val: 1 });
    });
  });

  describe('KV_CONSISTENCY_WARNING constant', () => {
    it('KV_CONSISTENCY_WARNING is exported and non-empty', () => {
      expect(KV_CONSISTENCY_WARNING).toBeDefined();
      expect(typeof KV_CONSISTENCY_WARNING).toBe('string');
      expect(KV_CONSISTENCY_WARNING.length).toBeGreaterThan(0);
    });
  });
});
