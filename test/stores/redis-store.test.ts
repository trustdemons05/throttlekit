/**
 * RedisStore tests using mocked ioredis.
 *
 * Covers:
 *   - apply creates new entry when key doesn't exist
 *   - apply updates existing entry
 *   - apply retries on WATCH conflict
 *   - apply throws after max retries exceeded
 *   - get returns stored value
 *   - get returns null for missing key
 *   - set stores value with TTL
 *   - delete removes key
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRedisStore } from '../../src/stores/redis.js';
import type { Store } from '../../src/core/types.js';

// ---------------------------------------------------------------------------
// Mock ioredis
// ---------------------------------------------------------------------------

/** Shared multi instance so tests can configure exec behaviour per-call */
const mockMultiInstance = {
  set: vi.fn().mockReturnThis(),
  exec: vi.fn().mockResolvedValue([[null, 'OK']]),
};

const MockRedis = vi.fn(() => ({
  watch: vi.fn().mockResolvedValue(undefined),
  get: vi.fn().mockResolvedValue(null),
  multi: vi.fn(() => mockMultiInstance),
  set: vi.fn().mockResolvedValue('OK'),
  del: vi.fn().mockResolvedValue(1),
}));

vi.mock('ioredis', () => ({
  Redis: MockRedis,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CounterState {
  count: number;
}

async function createStore() {
  return createRedisStore({ url: 'redis://localhost:6379' });
}

/** Assert the store implements get/set/delete (they are optional on Store) */
function assertFullStore(
  store: Store,
): asserts store is Store &
  Required<Pick<Store, 'get' | 'set' | 'delete'>> {
  if (!store.get || !store.set || !store.delete) {
    throw new Error('Store must implement get/set/delete');
  }
}

function getRedisInstance() {
  return MockRedis.mock.results[0]!.value;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RedisStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset shared multi exec to default success
    mockMultiInstance.exec.mockResolvedValue([[null, 'OK']]);
  });

  describe('apply', () => {
    it('creates a new entry when key does not exist', async () => {
      const store = await createStore();
      assertFullStore(store);

      const result = await store.apply<CounterState, boolean>(
        'new-key',
        60_000,
        (prev) => {
          const state: CounterState = { count: (prev?.count ?? 0) + 1 };
          return { state, result: true };
        },
      );

      expect(result).toBe(true);
      const redis = getRedisInstance();
      // Should have watched the key, read it, and executed a MULTI set
      expect(redis.watch).toHaveBeenCalledWith('new-key');
      expect(mockMultiInstance.set).toHaveBeenCalledWith(
        'new-key',
        JSON.stringify({ count: 1 }),
        'PX',
        60_000,
      );
    });

    it('updates an existing entry', async () => {
      const store = await createStore();
      assertFullStore(store);
      const redis = getRedisInstance();
      redis.get.mockResolvedValueOnce(JSON.stringify({ count: 5 }));

      const result = await store.apply<CounterState, number>(
        'existing-key',
        60_000,
        (prev) => {
          const state: CounterState = { count: (prev?.count ?? 0) + 1 };
          return { state, result: state.count };
        },
      );

      expect(result).toBe(6);
      expect(mockMultiInstance.set).toHaveBeenCalledWith(
        'existing-key',
        JSON.stringify({ count: 6 }),
        'PX',
        60_000,
      );
    });

    it('retries on WATCH conflict', async () => {
      const store = await createStore();
      assertFullStore(store);
      const redis = getRedisInstance();

      // First exec call returns null (WATCH conflict), second succeeds
      mockMultiInstance.exec
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce([[null, 'OK']]);

      const result = await store.apply<CounterState, boolean>(
        'conflict-key',
        60_000,
        (prev) => {
          const state: CounterState = { count: (prev?.count ?? 0) + 1 };
          return { state, result: true };
        },
      );

      expect(result).toBe(true);
      // Should have watched twice (first attempt + retry)
      expect(redis.watch).toHaveBeenCalledTimes(2);
    });

    it('throws after max retries exceeded', async () => {
      const store = await createStore();
      assertFullStore(store);
      const redis = getRedisInstance();

      // All exec calls return null (perpetual conflicts)
      mockMultiInstance.exec.mockResolvedValue(null);

      await expect(
        store.apply<CounterState, boolean>('fail-key', 60_000, (prev) => {
          const state: CounterState = { count: (prev?.count ?? 0) + 1 };
          return { state, result: true };
        }),
      ).rejects.toThrow('RedisStore: max retries exceeded');

      // Should have watched 3 times (initial + 2 retries)
      expect(redis.watch).toHaveBeenCalledTimes(3);
    });
  });

  describe('get', () => {
    it('returns stored value', async () => {
      const store = await createStore();
      assertFullStore(store);
      const redis = getRedisInstance();
      redis.get.mockResolvedValueOnce(JSON.stringify({ count: 42 }));

      const result = await store.get<CounterState>('some-key');
      expect(result).toEqual({ count: 42 });
    });

    it('returns null for missing key', async () => {
      const store = await createStore();
      assertFullStore(store);
      const redis = getRedisInstance();
      redis.get.mockResolvedValueOnce(null);

      const result = await store.get<CounterState>('missing-key');
      expect(result).toBeNull();
    });
  });

  describe('set', () => {
    it('stores value with TTL', async () => {
      const store = await createStore();
      assertFullStore(store);
      const redis = getRedisInstance();

      await store.set('ttl-key', { value: 100 }, 30_000);

      expect(redis.set).toHaveBeenCalledWith(
        'ttl-key',
        JSON.stringify({ value: 100 }),
        'PX',
        30_000,
      );
    });

    it('stores value without TTL', async () => {
      const store = await createStore();
      assertFullStore(store);
      const redis = getRedisInstance();

      await store.set('no-ttl-key', 'hello');

      expect(redis.set).toHaveBeenCalledWith(
        'no-ttl-key',
        JSON.stringify('hello'),
      );
    });
  });

  describe('delete', () => {
    it('removes a key', async () => {
      const store = await createStore();
      assertFullStore(store);
      const redis = getRedisInstance();

      await store.delete('delete-key');

      expect(redis.del).toHaveBeenCalledWith('delete-key');
    });
  });
});
