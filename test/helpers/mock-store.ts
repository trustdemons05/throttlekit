/**
 * Mock store factories for adapter and integration tests.
 *
 * These mocks implement the Store interface and can be used to
 * test error handling, operation tracking, etc.
 */
import type { Store } from '../../src/core/types.js';

/**
 * Creates a Store that always throws on any operation.
 * Useful for testing error-handling paths.
 */
export function createFailingStore(): Store {
  return {
    apply: <S, T>(
      _key: string,
      _ttlMs: number,
      _transform: (state: S | null) => { state: S; result: T }
    ): Promise<T> => {
      throw new Error('Store failure: apply() always throws');
    },

    get: <T>(_key: string): Promise<T | null> => {
      throw new Error('Store failure: get() always throws');
    },

    set: <T>(_key: string, _value: T, _ttlMs?: number): Promise<void> => {
      throw new Error('Store failure: set() always throws');
    },

    delete: (_key: string): Promise<void> => {
      throw new Error('Store failure: delete() always throws');
    },
  };
}

/**
 * Creates a Store that fails operations based on a predicate.
 *
 * @param shouldFail - Function called on each operation;
 *                     when it returns `true` the operation throws.
 *
 * The store does not contain any backing state. For a working flaky store
 * wrap a real store via `createSpyStore`.
 */
export function createFlakyStore(shouldFail: () => boolean): Store {
  const maybeThrow = (method: string): void => {
    if (shouldFail()) {
      throw new Error(`Flaky store failure: ${method}() failed`);
    }
  };

  return {
    apply: <S, T>(
      _key: string,
      _ttlMs: number,
      _transform: (state: S | null) => { state: S; result: T }
    ): Promise<T> => {
      maybeThrow('apply');
      throw new Error('Flaky store: apply() not implemented');
    },

    get: <T>(_key: string): Promise<T | null> => {
      maybeThrow('get');
      throw new Error('Flaky store: get() not implemented');
    },

    set: <T>(_key: string, _value: T, _ttlMs?: number): Promise<void> => {
      maybeThrow('set');
      throw new Error('Flaky store: set() not implemented');
    },

    delete: (_key: string): Promise<void> => {
      maybeThrow('delete');
      throw new Error('Flaky store: delete() not implemented');
    },
  };
}

/**
 * Record of a single store operation captured by a spy store.
 */
export interface StoreOperation {
  op: 'apply' | 'get' | 'set' | 'delete';
  key: string;
}

/**
 * Wraps a real Store and records every operation for test assertions.
 *
 * @example
 * ```typescript
 * const inner = new MemoryStore();
 * const spy = createSpyStore(inner);
 * await spy.apply('key', 1000, (s) => ({ state: s, result: true }));
 * expect(spy.operations).toHaveLength(1);
 * expect(spy.operations[0]).toEqual({ op: 'apply', key: 'key' });
 * ```
 */
export function createSpyStore(
  inner: Store
): Store & { operations: StoreOperation[] } {
  const operations: StoreOperation[] = [];

  const record = (op: StoreOperation['op'], key: string): void => {
    operations.push({ op, key });
  };

  return {
    operations,

    apply: <S, T>(
      key: string,
      ttlMs: number,
      transform: (state: S | null) => { state: S; result: T }
    ): Promise<T> => {
      record('apply', key);
      return inner.apply<S, T>(key, ttlMs, transform);
    },

    get: <T>(key: string): Promise<T | null> => {
      record('get', key);
      if (inner.get) {
        return inner.get<T>(key);
      }
      return Promise.resolve(null);
    },

    set: <T>(key: string, value: T, ttlMs?: number): Promise<void> => {
      record('set', key);
      if (inner.set) {
        return inner.set(key, value, ttlMs);
      }
      return Promise.resolve();
    },

    delete: (key: string): Promise<void> => {
      record('delete', key);
      if (inner.delete) {
        return inner.delete(key);
      }
      return Promise.resolve();
    },
  };
}
