/**
 * Tests for DurableObjectStore + ThrottleKitDO.
 *
 * Uses in-memory mocks for the Durable Object infrastructure so tests
 * run in Node.js without any Cloudflare SDK dependency.
 */

import { describe, it, expect } from 'vitest';
import {
  DurableObjectStore,
  ThrottleKitDO,
} from '../../src/stores/cloudflare-do.js';
import type {
  DurableObjectNamespace,
  DurableObjectId,
  DurableObjectStoreOptions,
  DurableObjectStub,
  DurableObjectState,
  DurableObjectStorage,
} from '../../src/stores/cloudflare-do.js';

// ---------------------------------------------------------------------------
// Mock implementations
// ---------------------------------------------------------------------------

class MockDurableObjectStorage implements DurableObjectStorage {
  private data = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }

  async setAlarm(_scheduledTime: number): Promise<void> {
    // no-op for testing
  }
}

class MockDurableObjectState implements DurableObjectState {
  storage: DurableObjectStorage;

  constructor() {
    this.storage = new MockDurableObjectStorage();
  }
}

class MockDurableObjectStub implements DurableObjectStub {
  private doInstance: ThrottleKitDO;
  /** Promise chain to serialise requests like real Durable Objects. */
  private lock: Promise<void> = Promise.resolve();

  constructor(state: DurableObjectState) {
    this.doInstance = new ThrottleKitDO(state);
  }

  async fetch(request: Request): Promise<Response> {
    const prev = this.lock;
    let release: () => void;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await this.doInstance.fetch(request);
    } finally {
      release!();
    }
  }
}

class MockDurableObjectNamespace implements DurableObjectNamespace {
  private stubs = new Map<string, MockDurableObjectStub>();
  private doStates = new Map<string, DurableObjectState>();

  idFromName(name: string): DurableObjectId {
    return { toString: () => name };
  }

  get(id: DurableObjectId): DurableObjectStub {
    const key = id.toString();
    let stub = this.stubs.get(key);
    if (!stub) {
      const state = new MockDurableObjectState();
      this.doStates.set(key, state);
      stub = new MockDurableObjectStub(state);
      this.stubs.set(key, stub);
    }
    return stub;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CounterState {
  count: number;
}

function createStore(prefix?: string): DurableObjectStore {
  const namespace = new MockDurableObjectNamespace();
  const options: DurableObjectStoreOptions = { namespace };
  if (prefix !== undefined) {
    options.prefix = prefix;
  }
  return new DurableObjectStore(options);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DurableObjectStore', () => {
  describe('get / set / delete', () => {
    it('stores and retrieves a value via set / get', async () => {
      const store = createStore();
      await store.set('key', { name: 'test', value: 42 });
      const result = await store.get<{ name: string; value: number }>('key');
      expect(result).toEqual({ name: 'test', value: 42 });
    });

    it('returns null for a missing key', async () => {
      const store = createStore();
      const result = await store.get<unknown>('nonexistent');
      expect(result).toBeNull();
    });

    it('delete removes a key', async () => {
      const store = createStore();
      await store.set('key', 'hello');
      await store.delete('key');
      const result = await store.get<string>('key');
      expect(result).toBeNull();
    });
  });

  describe('apply', () => {
    it('creates a new entry if none exists', async () => {
      const store = createStore();
      const result = await store.apply<CounterState, boolean>(
        'counter-key',
        60_000,
        (prev) => {
          const state: CounterState = { count: (prev?.count ?? 0) + 1 };
          return { state, result: true };
        },
      );
      expect(result).toBe(true);
      const stored = await store.get<CounterState>('counter-key');
      expect(stored).toEqual({ count: 1 });
    });

    it('reads existing state and updates it', async () => {
      const store = createStore();
      const LIMIT = 3;

      // Insert initial state
      await store.set('counter', { count: 0 });

      const attempt = async () =>
        store.apply<CounterState, { allowed: boolean }>(
          'counter',
          60_000,
          (prev) => {
            const current = prev?.count ?? 0;
            if (current >= LIMIT) {
              return {
                state: prev ?? { count: 0 },
                result: { allowed: false },
              };
            }
            return {
              state: { count: current + 1 },
              result: { allowed: true },
            };
          },
        );

      // First 3 should succeed
      expect((await attempt()).allowed).toBe(true);
      expect((await attempt()).allowed).toBe(true);
      expect((await attempt()).allowed).toBe(true);

      // 4th should be rejected
      expect((await attempt()).allowed).toBe(false);

      // Verify final count
      const stored = await store.get<CounterState>('counter');
      expect(stored?.count).toBe(LIMIT);
    });

    it('handles expired state as null', async () => {
      const store = createStore();
      // Set a value with a very short TTL
      await store.set('expiring', { count: 100 }, 1);
      // Wait for it to expire
      await new Promise((resolve) => setTimeout(resolve, 10));
      // apply should see null because the entry has expired
      const result = await store.apply<CounterState, number>(
        'expiring',
        60_000,
        (prev) => {
          // prev should be null since the entry expired
          const state: CounterState = { count: (prev?.count ?? 0) + 1 };
          return { state, result: state.count };
        },
      );
      expect(result).toBe(1);
      const stored = await store.get<CounterState>('expiring');
      expect(stored?.count).toBe(1);
    });
  });

  describe('get returns null for expired state', () => {
    it('returns null when TTL has passed', async () => {
      const store = createStore();
      await store.set('short-lived', 'value', 1);
      // Wait for expiry
      await new Promise((resolve) => setTimeout(resolve, 10));
      const result = await store.get<string>('short-lived');
      expect(result).toBeNull();
    });
  });

  describe('concurrency / atomicity', () => {
    it('serialises concurrent apply calls correctly', async () => {
      const store = createStore();
      const CONCURRENCY = 50;

      const tasks = Array.from({ length: CONCURRENCY }, () =>
        store.apply<CounterState, number>('concurrent-key', 60_000, (prev) => {
          const state: CounterState = { count: (prev?.count ?? 0) + 1 };
          return { state, result: state.count };
        }),
      );

      const results = await Promise.all(tasks);

      // All operations should complete
      expect(results.length).toBe(CONCURRENCY);

      // The final stored count should be exactly CONCURRENCY
      const stored = await store.get<CounterState>('concurrent-key');
      expect(stored?.count).toBe(CONCURRENCY);

      // Each result should be unique (1..CONCURRENCY)
      const unique = new Set(results);
      expect(unique.size).toBe(CONCURRENCY);
    });
  });

  describe('prefix isolation', () => {
    it('isolates keys with different prefixes', async () => {
      const namespace = new MockDurableObjectNamespace();
      const storeA = new DurableObjectStore({ namespace, prefix: 'a:' });
      const storeB = new DurableObjectStore({ namespace, prefix: 'b:' });

      await storeA.set('key', 'value-a');
      await storeB.set('key', 'value-b');

      const resultA = await storeA.get<string>('key');
      const resultB = await storeB.get<string>('key');

      expect(resultA).toBe('value-a');
      expect(resultB).toBe('value-b');
    });

    it('allows same prefix to access same data', async () => {
      const namespace = new MockDurableObjectNamespace();
      const store1 = new DurableObjectStore({ namespace, prefix: 'shared:' });
      const store2 = new DurableObjectStore({ namespace, prefix: 'shared:' });

      await store1.set('data', { x: 1 });
      const result = await store2.get<{ x: number }>('data');
      expect(result).toEqual({ x: 1 });
    });

    it('applies and reads state correctly when a prefix is used (fixes double-prefix bug)', async () => {
      const namespace = new MockDurableObjectNamespace();
      const store = new DurableObjectStore({ namespace, prefix: 'my-prefix:' });
      await store.apply<CounterState, boolean>(
        'my-key',
        60_000,
        (prev) => {
          const state: CounterState = { count: (prev?.count ?? 0) + 1 };
          return { state, result: true };
        },
      );
      const stored = await store.get<CounterState>('my-key');
      expect(stored).toEqual({ count: 1 });
    });
  });
});

describe('ThrottleKitDO.fetch', () => {
  it('GET returns null for missing key', async () => {
    // Create a ThrottleKitDO directly
    const state = new MockDurableObjectState();
    const doInstance = new ThrottleKitDO(state as DurableObjectState);

    const response = await doInstance.fetch(
      new Request('http://do/missing-key', { method: 'GET' }),
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toBeNull();
  });

  it('POST stores and GET retrieves', async () => {
    const state = new MockDurableObjectState();
    const doInstance = new ThrottleKitDO(state as DurableObjectState);

    // POST a value
    const postResponse = await doInstance.fetch(
      new Request('http://do/my-key', {
        method: 'POST',
        body: JSON.stringify({ state: { hello: 'world' }, ttlMs: 60_000 }),
      }),
    );
    expect(postResponse.status).toBe(200);
    const postBody = await postResponse.json();
    expect(postBody).toEqual({ ok: true });

    // GET it back
    const getResponse = await doInstance.fetch(
      new Request('http://do/my-key', { method: 'GET' }),
    );
    const getData = await getResponse.json();
    expect(getData).toEqual({ hello: 'world' });
  });

  it('DELETE removes stored data', async () => {
    const state = new MockDurableObjectState();
    const doInstance = new ThrottleKitDO(state as DurableObjectState);

    // Store something
    await doInstance.fetch(
      new Request('http://do/del-key', {
        method: 'POST',
        body: JSON.stringify({ state: 'to-delete', ttlMs: 60_000 }),
      }),
    );

    // Delete it
    const delResponse = await doInstance.fetch(
      new Request('http://do/del-key', { method: 'DELETE' }),
    );
    expect(delResponse.status).toBe(200);
    const delBody = await delResponse.json();
    expect(delBody).toEqual({ ok: true });

    // Verify it's gone
    const getResponse = await doInstance.fetch(
      new Request('http://do/del-key', { method: 'GET' }),
    );
    expect(await getResponse.json()).toBeNull();
  });

  it('returns 405 for unknown HTTP methods', async () => {
    const state = new MockDurableObjectState();
    const doInstance = new ThrottleKitDO(state as DurableObjectState);

    const response = await doInstance.fetch(
      new Request('http://do/some-key', { method: 'PATCH' }),
    );
    expect(response.status).toBe(405);
    const text = await response.text();
    expect(text).toBe('Method not allowed');
  });

  it('GET returns null for expired entry', async () => {
    const state = new MockDurableObjectState();
    const doInstance = new ThrottleKitDO(state as DurableObjectState);

    // Store with 0ms TTL (immediately expired)
    await doInstance.fetch(
      new Request('http://do/exp-key', {
        method: 'POST',
        body: JSON.stringify({ state: 'will-expire', ttlMs: 0 }),
      }),
    );

    // GET should return null because expiresAt <= Date.now()
    const getResponse = await doInstance.fetch(
      new Request('http://do/exp-key', { method: 'GET' }),
    );
    expect(await getResponse.json()).toBeNull();
  });
});
