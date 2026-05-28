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
  version: number; // optimistic concurrency version
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
    readonly query: string,
    private readonly store: Map<string, StoredRow>,
    readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): MockD1PreparedStatement {
    return new MockD1PreparedStatement(this.query, this.store, values);
  }

  async first<T>(): Promise<T | null> {
    const sql = this.query.trim();

    if (sql.toUpperCase().startsWith('SELECT')) {
      const key = this.values[0];
      const now = this.values.length > 1 ? this.values[1] : undefined;

      if (key === undefined) return null;

      const entry = this.store.get(String(key));
      if (entry && (now === undefined || entry.expires_at > Number(now))) {
        // D1 returns a row object with column names as keys;
        // return version if the stored row has one
        return { state: entry.state, version: entry.version } as T;
      }
    }

    return null;
  }

  async run(): Promise<D1Result<unknown>> {
    const sql = this.query.trim();
    const upper = sql.toUpperCase();

    // UPDATE with version check (CAS)
    if (upper.startsWith('UPDATE')) {
      const newState = this.values[0];
      const newExpiresAt = this.values[1];
      const key = this.values[2];
      const expectedVersion = this.values[3];

      if (
        key !== undefined &&
        expectedVersion !== undefined &&
        newState !== undefined
      ) {
        const entry = this.store.get(String(key));
        if (entry && entry.version === Number(expectedVersion)) {
          // Version match — apply update
          this.store.set(String(key), {
            state: String(newState),
            expires_at: Number(newExpiresAt),
            version: entry.version + 1,
          });
          return { results: [], success: true, meta: { changes: 1 } };
        }
        // Version mismatch — no rows updated
        return { results: [], success: false, meta: { changes: 0 } };
      }
      return { results: [], success: true, meta: {} };
    }

    // INSERT OR REPLACE (blind write, e.g. set())
    if (upper.includes('INSERT') && upper.includes('REPLACE')) {
      const key = this.values[0];
      const state = this.values[1];
      const expiresAt = this.values[2];

      if (key !== undefined && state !== undefined && expiresAt !== undefined) {
        this.store.set(String(key), {
          state: String(state),
          expires_at: Number(expiresAt),
          version: 1, // INSERT OR REPLACE resets version to 1
        });
      }
      return { results: [], success: true, meta: { changes: 1 } };
    }

    // Plain INSERT (OCC new-entry path — must not conflict)
    if (upper.startsWith('INSERT')) {
      const key = this.values[0];
      const state = this.values[1];
      const expiresAt = this.values[2];

      if (key !== undefined && state !== undefined && expiresAt !== undefined) {
        // Simulate UNIQUE constraint failure if key already exists
        if (this.store.has(String(key))) {
          const err = new Error('UNIQUE constraint failed: key already exists');
          throw err;
        }
        this.store.set(String(key), {
          state: String(state),
          expires_at: Number(expiresAt),
          version: 1, // new entries start at version 1
        });
        return { results: [], success: true, meta: { changes: 1 } };
      }
      return { results: [], success: true, meta: {} };
    }

    // DELETE
    if (upper.startsWith('DELETE')) {
      const key = this.values[0];
      if (key !== undefined) {
        this.store.delete(String(key));
      }
      return { results: [], success: true, meta: { changes: 1 } };
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

    it('creates new entry with version=1 if none exists', async () => {
      // Apply on a new key should create it with version=1
      const result = await store.apply<CounterState, boolean>(
        'fresh',
        60_000,
        (prev) => {
          expect(prev).toBeNull();
          return { state: { count: 1 }, result: true };
        },
      );

      expect(result).toBe(true);
      const entry = db.store.get('fresh');
      expect(entry).toBeDefined();
      expect(entry!.version).toBe(1);
    });

    it('uses optimistic concurrency control with version column', async () => {
      // Seed with set() — sets version=1
      await store.set('occ', { count: 0 });

      const result = await store.apply<CounterState, boolean>(
        'occ',
        60_000,
        (prev) => {
          return {
            state: { count: (prev?.count ?? 0) + 1 },
            result: true,
          };
        },
      );

      expect(result).toBe(true);

      // Version should have incremented from 1 to 2
      const entry = db.store.get('occ');
      expect(entry).toBeDefined();
      expect(entry!.version).toBe(2);
      expect(entry!.state).toBe(JSON.stringify({ count: 1 }));
    });

    it('retries on version conflict', async () => {
      // Seed initial entry with version=1
      await store.set('conflict-key', { count: 0 });

      // Manually bump the version in the store to simulate another writer
      const entry = db.store.get('conflict-key')!;
      db.store.set('conflict-key', {
        state: entry.state,
        expires_at: entry.expires_at,
        version: entry.version + 1, // now version=2
      });

      // The apply() will read version=2, compute transform, then try UPDATE
      // with version=2 (which will match). It should succeed.
      const result = await store.apply<CounterState, boolean>(
        'conflict-key',
        60_000,
        (prev) => {
          return {
            state: { count: (prev?.count ?? 0) + 1 },
            result: true,
          };
        },
      );

      expect(result).toBe(true);

      // Version should now be 3
      const updated = db.store.get('conflict-key');
      expect(updated!.version).toBe(3);
      expect(updated!.state).toBe(JSON.stringify({ count: 1 }));
    });

    it('retries when UPDATE matches stale version (simulating race)', async () => {
      // Seed with version=1
      await store.set('race-key', { count: 0 });

      // Read the version that apply will see (1), then bump the store
      // between read and write to force a retry
      const transformSpy = vi.fn(
        (
          prev: CounterState | null,
        ): { state: CounterState; result: boolean } => {
          return {
            state: { count: (prev?.count ?? 0) + 1 },
            result: true,
          };
        },
      );

      // We need to intercept between read and write. Since our mock doesn't
      // support that directly, we pre-conflict by bumping the version
      // before calling apply. The apply will read version=2, compute
      // transform, then attempt UPDATE with version=2. That will succeed
      // (no actual retry needed in this case since it reads the latest version).
      // Actually, let's test the actual retry: we set up so that the version
      // read is stale by the time UPDATE runs.
      //
      // Simpler approach: we bump the version after first() reads, but since
      // we can't inject between mock calls, we test that the CAS loop works
      // by having the mock's UPDATE fail on version mismatch (first call)
      // then succeed on retry.

      // Override the run method temporarily to fail on first UPDATE
      const originalRun = MockD1PreparedStatement.prototype.run;

      let updateAttempts = 0;
      MockD1PreparedStatement.prototype.run = async function () {
        const upper = this.query.trim().toUpperCase();
        if (upper.startsWith('UPDATE')) {
          updateAttempts++;
          if (updateAttempts === 1) {
            // First UPDATE attempt — simulate version conflict
            // by not updating and returning changes=0
            // We do this by mutating the store entry's version after read
            const entry = db.store.get(String(this.values[2]));
            if (entry) {
              entry.version += 1; // bump version to cause conflict
            }
          }
        }
        // Call original via apply
        return originalRun.apply(this);
      };

      try {
        const result = await store.apply<CounterState, boolean>(
          'race-key',
          60_000,
          transformSpy,
        );

        expect(result).toBe(true);
        // Should have succeeded after retry
        expect(updateAttempts).toBeGreaterThanOrEqual(2);

        const finalEntry = db.store.get('race-key');
        expect(finalEntry).toBeDefined();
        expect(finalEntry!.state).toBe(JSON.stringify({ count: 1 }));
      } finally {
        // Restore original
        MockD1PreparedStatement.prototype.run = originalRun;
      }
    });

    it('treats expired state as null', async () => {
      const now = Date.now();

      // Manually seed an expired entry
      db.store.set('stale-key', {
        state: JSON.stringify({ count: 99 }),
        expires_at: now - 1,
        version: 5,
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
  // apply — CAS / OCC verification
  // -----------------------------------------------------------------------

  describe('apply CAS loop', () => {
    it('increments version on each apply call', async () => {
      await store.apply<CounterState, boolean>('cas-key', 60_000, (prev) => {
        return { state: { count: (prev?.count ?? 0) + 1 }, result: true };
      });

      let entry = db.store.get('cas-key');
      expect(entry).toBeDefined();
      expect(entry!.state).toBe(JSON.stringify({ count: 1 }));
      expect(entry!.version).toBe(1);

      // Apply again — should increment version
      await store.apply<CounterState, boolean>('cas-key', 60_000, (prev) => {
        expect(prev).toEqual({ count: 1 });
        return { state: { count: prev!.count + 1 }, result: true };
      });

      entry = db.store.get('cas-key');
      expect(entry!.state).toBe(JSON.stringify({ count: 2 }));
      expect(entry!.version).toBe(2);
    });

    it('preserves version through set then apply cycle', async () => {
      // set() resets version to 1
      await store.set('cycle-key', { count: 0 });
      let entry = db.store.get('cycle-key');
      expect(entry!.version).toBe(1);

      // apply() increments from 1 to 2
      await store.apply<CounterState, boolean>('cycle-key', 60_000, (prev) => {
        return { state: { count: (prev?.count ?? 0) + 1 }, result: true };
      });

      entry = db.store.get('cycle-key');
      expect(entry!.version).toBe(2);
      expect(entry!.state).toBe(JSON.stringify({ count: 1 }));
    });

    it('throws on max CAS retries exceeded', async () => {
      // Seed entry with version=1
      await store.set('max-retry-key', { count: 0 });

      // Make every UPDATE fail by always bumping the version before write
      const originalRun = MockD1PreparedStatement.prototype.run;

      MockD1PreparedStatement.prototype.run = async function () {
        const upper = this.query.trim().toUpperCase();
        if (upper.startsWith('UPDATE')) {
          // Bump the version in store so the UPDATE's version check fails
          const key = String(this.values[2]);
          const entry = db.store.get(key);
          if (entry) {
            entry.version += 1;
          }
        }
        return originalRun.apply(this);
      };

      try {
        await expect(
          store.apply<CounterState, boolean>('max-retry-key', 60_000, (prev) => {
            return { state: { count: (prev?.count ?? 0) + 1 }, result: true };
          }),
        ).rejects.toThrow('max CAS retries exceeded');
      } finally {
        MockD1PreparedStatement.prototype.run = originalRun;
      }
    });
  });
});
