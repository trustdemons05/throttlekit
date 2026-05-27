/**
 * D1Store tests — all mocking, no real Cloudflare D1 required.
 *
 * Covers:
 *   - ensureTable() runs idempotently
 *   - get() returns stored state
 *   - get() returns null for missing key
 *   - get() returns null for expired state
 *   - set() stores a value and get() retrieves it
 *   - set() with TTL and without TTL
 *   - delete() removes a key
 *   - apply() creates new entry if none exists
 *   - apply() reads existing state and transforms it
 *   - apply() treats expired state as null
 *   - apply() stores state as JSON TEXT
 *   - prefix option isolates keys correctly
 *   - custom tableName works
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { D1Store } from '../../src/stores/cloudflare-d1.js';
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
  D1ExecResult,
} from '../../src/stores/cloudflare-d1.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CounterState {
  count: number;
}

/**
 * In-memory row representation matching the D1 table schema.
 */
interface StoredRow {
  state: string; // JSON-serialised
  expires_at: number; // epoch ms
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/**
 * Mock implementation of D1PreparedStatement.
 *
 * Parses the SQL to determine what operation to perform and operates
 * on the parent database's in-memory store. Immutable on bind() —
 * returns a new instance with the bound values.
 */
class MockD1PreparedStatement implements D1PreparedStatement {
  constructor(
    private readonly query: string,
    private readonly store: Map<string, StoredRow>,
    private readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): MockD1PreparedStatement {
    return new MockD1PreparedStatement(this.query, this.store, values);
  }

  async first<T>(): Promise<T | null> {
    const sql = this.query.trim();

    if (sql.toUpperCase().startsWith('SELECT')) {
      const key = this.values[0];
      const now = this.values[1];

      if (key === undefined) return null;

      const entry = this.store.get(String(key));
      if (entry && (now === undefined || entry.expires_at > Number(now))) {
        // D1 returns a row object with column names as keys
        return { state: entry.state } as T;
      }
    }

    return null;
  }

  async run(): Promise<D1Result<unknown>> {
    const sql = this.query.trim().toUpperCase();

    // INSERT OR REPLACE
    if (sql.includes('INSERT')) {
      const key = this.values[0];
      const state = this.values[1];
      const expiresAt = this.values[2];

      if (key !== undefined && state !== undefined && expiresAt !== undefined) {
        this.store.set(String(key), {
          state: String(state),
          expires_at: Number(expiresAt),
        });
      }
      return { results: [], success: true, meta: {} };
    }

    // DELETE
    if (sql.startsWith('DELETE')) {
      const key = this.values[0];
      if (key !== undefined) {
        this.store.delete(String(key));
      }
      return { results: [], success: true, meta: {} };
    }

    // CREATE TABLE — no-op in mock
    return { results: [], success: true, meta: {} };
  }

  async all<T>(): Promise<D1Result<T>> {
    // Not used by D1Store, but implement for interface conformance
    return { results: [], success: true, meta: {} };
  }
}

/**
 * Mock implementation of D1Database.
 *
 * Maintains an in-memory Map of rows and tracks all exec() calls
 * for test assertions.
 */
class MockD1Database implements D1Database {
  readonly store: Map<string, StoredRow> = new Map();
  readonly execCalls: string[] = [];

  prepare(query: string): MockD1PreparedStatement {
    return new MockD1PreparedStatement(query, this.store);
  }

  async exec(query: string): Promise<D1ExecResult> {
    this.execCalls.push(query);
    return { count: 0, duration: 0 };
  }

  async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    // Execute each statement in the batch by delegating to its run() method
    const results: D1Result<T>[] = [];
    for (const stmt of statements) {
      const result = await stmt.run();
      results.push(result as D1Result<T>);
    }
    return results;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('D1Store', () => {
  let db: MockD1Database;
  let store: D1Store;

  beforeEach(() => {
    db = new MockD1Database();
    store = new D1Store({ db });
  });

  // -----------------------------------------------------------------------
  // ensureTable
  // -----------------------------------------------------------------------

  describe('ensureTable', () => {
    it('runs without error', async () => {
      await store.ensureTable();

      expect(db.execCalls).toHaveLength(1);
      expect(db.execCalls[0]).toContain('CREATE TABLE IF NOT EXISTS');
      expect(db.execCalls[0]).toContain('throttlekit_state');
    });

    it('is idempotent (can be called multiple times)', async () => {
      await store.ensureTable();
      await store.ensureTable();

      expect(db.execCalls).toHaveLength(2);
    });

    it('accepts a custom tableName', async () => {
      const customStore = new D1Store({ db, tableName: 'my_ratelimit_state' });
      await customStore.ensureTable();

      expect(db.execCalls).toHaveLength(1);
      expect(db.execCalls[0]).toContain('my_ratelimit_state');
    });
  });

  // -----------------------------------------------------------------------
  // set and get
  // -----------------------------------------------------------------------

  describe('set and get', () => {
    it('stores and retrieves a value', async () => {
      await store.set('key', { value: 42 });
      const result = await store.get<{ value: number }>('key');
      expect(result).toEqual({ value: 42 });
    });

    it('returns null for a missing key', async () => {
      const result = await store.get<unknown>('nonexistent');
      expect(result).toBeNull();
    });

    it('overwrites an existing key', async () => {
      await store.set('key', 'first');
      await store.set('key', 'second');
      const result = await store.get<string>('key');
      expect(result).toBe('second');
    });
  });

  // -----------------------------------------------------------------------
  // delete
  // -----------------------------------------------------------------------

  describe('delete', () => {
    it('removes a key', async () => {
      await store.set('key', 'hello');
      await store.delete('key');
      const result = await store.get<string>('key');
      expect(result).toBeNull();
    });

    it('is idempotent for missing key', async () => {
      await expect(store.delete('nada')).resolves.toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // TTL behaviour
  // -----------------------------------------------------------------------

  describe('TTL behaviour', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('get returns null for expired state', async () => {
      const now = Date.now();
      vi.setSystemTime(now);

      await store.set('key', 'value', 100);

      // Advance past TTL
      vi.setSystemTime(now + 200);
      const result = await store.get<string>('key');
      expect(result).toBeNull();
    });

    it('get returns value within TTL', async () => {
      const now = Date.now();
      vi.setSystemTime(now);

      await store.set('key', 'alive', 100);

      // Still within TTL
      vi.setSystemTime(now + 99);
      const result = await store.get<string>('key');
      expect(result).toBe('alive');
    });

    it('set without TTL uses far-future expiry', async () => {
      const now = Date.now();
      vi.setSystemTime(now);

      await store.set('key', 'persistent');

      // Advance far into the future but within FAR_FUTURE_MS
      vi.setSystemTime(now + 86_400_000); // 1 day
      const result = await store.get<string>('key');
      expect(result).toBe('persistent');
    });

    it('TTL is refreshed on set', async () => {
      const now = Date.now();
      vi.setSystemTime(now);

      await store.set('key', 'first', 100);
      // Advance 80ms — still within first TTL
      vi.setSystemTime(now + 80);
      // Re-set with a fresh TTL
      await store.set('key', 'second', 100);
      // Advance another 80ms — original TTL would be expired, new TTL is valid
      vi.setSystemTime(now + 160);
      const result = await store.get<string>('key');
      expect(result).toBe('second');
    });
  });

  // -----------------------------------------------------------------------
  // apply
  // -----------------------------------------------------------------------

  describe('apply', () => {
    it('creates a new entry if none exists', async () => {
      const result = await store.apply<CounterState, boolean>(
        'new-key',
        60_000,
        (prev) => {
          expect(prev).toBeNull();
          const state: CounterState = { count: 1 };
          return { state, result: true };
        },
      );

      expect(result).toBe(true);
      const stored = await store.get<CounterState>('new-key');
      expect(stored).toEqual({ count: 1 });
    });

    it('reads existing state and transforms it', async () => {
      // Seed initial state
      await store.set('counter', { count: 0 });

      const result = await store.apply<CounterState, { allowed: boolean }>(
        'counter',
        60_000,
        (prev) => {
          const current = prev?.count ?? 0;
          if (current >= 3) {
            return { state: prev ?? { count: 0 }, result: { allowed: false } };
          }
          return { state: { count: current + 1 }, result: { allowed: true } };
        },
      );

      expect(result).toEqual({ allowed: true });
      const stored = await store.get<CounterState>('counter');
      expect(stored?.count).toBe(1);
    });

    it('reads existing state and can reject (limit exceeded)', async () => {
      // Seed initial state at the limit
      await store.set('counter', { count: 3 });

      const result = await store.apply<CounterState, { allowed: boolean }>(
        'counter',
        60_000,
        (prev) => {
          const current = prev?.count ?? 0;
          if (current >= 3) {
            return { state: prev ?? { count: 0 }, result: { allowed: false } };
          }
          return { state: { count: current + 1 }, result: { allowed: true } };
        },
      );

      expect(result).toEqual({ allowed: false });
      const stored = await store.get<CounterState>('counter');
      expect(stored?.count).toBe(3); // unchanged
    });

    it('stores state as JSON TEXT', async () => {
      await store.apply<CounterState, boolean>('json-key', 60_000, () => {
        return { state: { count: 42 }, result: true };
      });

      // Inspect the raw stored entry — state should be a JSON string
      const entry = db.store.get('json-key');
      expect(entry).toBeDefined();
      expect(entry!.state).toBe(JSON.stringify({ count: 42 }));
    });

    it('treats expired state as null', async () => {
      const now = Date.now();

      // Manually seed an expired entry
      db.store.set('stale-key', {
        state: JSON.stringify({ count: 99 }),
        expires_at: now - 1,
      });

      const transformSpy = vi.fn(
        (prev: CounterState | null): { state: CounterState; result: number } => {
          expect(prev).toBeNull();
          return { state: { count: 1 }, result: 1 };
        },
      );

      const result = await store.apply<CounterState, number>(
        'stale-key',
        60_000,
        transformSpy,
      );

      expect(result).toBe(1);
      expect(transformSpy).toHaveBeenCalledTimes(1);

      // Verify the stale entry was replaced
      const stored = await store.get<CounterState>('stale-key');
      expect(stored).toEqual({ count: 1 });
    });
  });

  // -----------------------------------------------------------------------
  // prefix option
  // -----------------------------------------------------------------------

  describe('prefix option', () => {
    it('isolates keys with different prefixes', async () => {
      const storeA = new D1Store({ db, prefix: 'app1:' });
      const storeB = new D1Store({ db, prefix: 'app2:' });

      await storeA.set('key', 'value-a');
      await storeB.set('key', 'value-b');

      // Each store reads its own namespaced entry
      expect(await storeA.get<string>('key')).toBe('value-a');
      expect(await storeB.get<string>('key')).toBe('value-b');

      // The raw store should have both entries with different keys
      expect(db.store.has('app1:key')).toBe(true);
      expect(db.store.has('app2:key')).toBe(true);
      expect(db.store.has('key')).toBe(false);
    });

    it('empty prefix does not alter keys', async () => {
      const noPrefix = new D1Store({ db });
      await noPrefix.set('key', 'bare');

      expect(db.store.has('key')).toBe(true);
      expect(await noPrefix.get<string>('key')).toBe('bare');
    });

    it('works with apply, get, set, delete', async () => {
      const prefixed = new D1Store({ db, prefix: 'ns:' });

      // apply
      await prefixed.apply<CounterState, boolean>('my-key', 60_000, (prev) => {
        return { state: { count: (prev?.count ?? 0) + 1 }, result: true };
      });
      expect(db.store.has('ns:my-key')).toBe(true);
      expect(db.store.has('my-key')).toBe(false);

      // get
      expect(await prefixed.get<CounterState>('my-key')).toEqual({ count: 1 });

      // set
      await prefixed.set('my-key', { count: 42 }, 60_000);
      expect(await prefixed.get<CounterState>('my-key')).toEqual({ count: 42 });

      // delete
      await prefixed.delete('my-key');
      expect(db.store.has('ns:my-key')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // apply — D1 atomicity documentation verification
  // -----------------------------------------------------------------------

  describe('apply atomicity caveat', () => {
    it('performs read-then-write (no advisory locks)', async () => {
      // Verify that apply() uses two separate D1 calls:
      // 1. SELECT (read)
      // 2. INSERT OR REPLACE (write)
      // We can't observe the exact query flow from the mock's prepare()
      // interface, but we can verify the mock store state changes correctly.

      await store.apply<CounterState, boolean>('atomic-key', 60_000, (prev) => {
        return { state: { count: (prev?.count ?? 0) + 1 }, result: true };
      });

      const entry = db.store.get('atomic-key');
      expect(entry).toBeDefined();
      expect(entry!.state).toBe(JSON.stringify({ count: 1 }));

      // Apply again — should read the existing state
      await store.apply<CounterState, boolean>('atomic-key', 60_000, (prev) => {
        expect(prev).toEqual({ count: 1 });
        return { state: { count: prev!.count + 1 }, result: true };
      });

      const updatedEntry = db.store.get('atomic-key');
      expect(updatedEntry!.state).toBe(JSON.stringify({ count: 2 }));
    });
  });
});
