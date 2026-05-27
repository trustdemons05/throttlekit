/**
 * PostgresStore tests — all mocking, no real Postgres required.
 *
 * Covers:
 *   - ensureTable() calls CREATE TABLE IF NOT EXISTS
 *   - apply() reads existing state and writes new state
 *   - apply() creates fresh state when key is missing
 *   - get() returns stored state
 *   - get() returns null for missing key
 *   - get() returns null for expired state
 *   - set() upserts state with TTL
 *   - set() upserts state without TTL (far-future sentinel)
 *   - delete() removes state
 *   - apply() acquires per-key advisory lock (pg_advisory_xact_lock)
 *   - apply() rolls back on error and releases client
 *   - prefix option namespaces keys correctly
 *   - Concurrent apply() calls on same key both succeed
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PostgresStore } from '../../src/stores/postgres.js';
import type { PgPool, PgClient } from '../../src/stores/postgres.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CounterState {
  count: number;
}

/**
 * Tracked query recorded during mock execution.
 */
interface TrackedQuery {
  text: string;
  values: unknown[] | undefined;
  target: 'pool' | 'client';
}

/**
 * In-memory row representation.
 */
interface MockRow {
  state: unknown;
  expiresAt: number; // epoch ms
}

/**
 * Create a fully instrumented mock pool + client pair.
 *
 * The returned `context` object exposes the internal data structures so tests
 * can inspect queries, lock calls, and the stored row map.
 */
function createMockContext() {
  const rows = new Map<string, MockRow>();
  const queries: TrackedQuery[] = [];
  const lockCalls: string[] = [];

  // Per-key promise chain mutex to simulate pg_advisory_xact_lock serialization
  const keyMutexes = new Map<string, Promise<void>>();

  const clock = { now: Date.now };

  /** Acquire per-key mutex — simulates pg_advisory_xact_lock in the mock. */
  async function acquireKeyMutex(key: string): Promise<void> {
    const prev = keyMutexes.get(key) ?? Promise.resolve();
    let release: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    keyMutexes.set(key, next);
    await prev;
    release!();
  }

  /** Shared query handler used by both pool and client. */
  async function handleQuery(
    text: string,
    values: unknown[] | undefined,
    target: 'pool' | 'client',
  ): Promise<{ rows: unknown[] }> {
    queries.push({ text, values, target });

    // Transaction control
    const upper = text.trim().toUpperCase();
    if (upper === 'BEGIN' || upper === 'COMMIT' || upper === 'ROLLBACK') {
      return { rows: [] };
    }

    // Advisory lock — serialize per key in the mock to simulate real Postgres locking
    if (text.includes('pg_advisory_xact_lock')) {
      const key = typeof values?.[0] === 'string' ? values[0] : String(values?.[0] ?? '');
      lockCalls.push(key);
      await acquireKeyMutex(key);
      return { rows: [] };
    }

    // CREATE TABLE IF NOT EXISTS
    if (text.includes('CREATE TABLE')) {
      return { rows: [] };
    }

    // DELETE
    if (upper.startsWith('DELETE')) {
      const key = values?.[0] as string | undefined;
      if (key) rows.delete(key);
      return { rows: [] };
    }

    // SELECT
    if (upper.startsWith('SELECT') && !text.includes('pg_advisory_xact_lock')) {
      const key = values?.[0] as string | undefined;
      if (key) {
        const row = rows.get(key);
        if (row && row.expiresAt > clock.now()) {
          return { rows: [{ state: row.state }] };
        }
        // Expired — clean up and return empty
        if (row && row.expiresAt <= clock.now()) {
          rows.delete(key);
        }
      }
      return { rows: [] };
    }

    // INSERT ... ON CONFLICT (UPSERT)
    if (text.includes('INSERT') && text.includes('ON CONFLICT')) {
      const key = values?.[0] as string | undefined;
      if (key && values && values.length >= 2) {
        const stateStr = values[1] as string;
        const state = JSON.parse(stateStr);

        let expiresAt: number;
        if (values.length >= 3 && values[2] !== undefined) {
          // TTL provided — compute expiry from now
          expiresAt = clock.now() + (values[2] as number);
        } else {
          // No TTL — far-future sentinel matching the literal in set() without TTL
          expiresAt = 9999999999999;
        }

        rows.set(key, { state, expiresAt });
      }
      return { rows: [] };
    }

    return { rows: [] };
  }

  const client: PgClient = {
    query: vi.fn((text: string, values?: unknown[]) =>
      Promise.resolve(handleQuery(text, values, 'client')),
    ),
    release: vi.fn(),
  };

  const pool: PgPool = {
    query: vi.fn((text: string, values?: unknown[]) =>
      Promise.resolve(handleQuery(text, values, 'pool')),
    ),
    connect: vi.fn(() => Promise.resolve(client)),
  };

  return { pool, client, rows, queries, lockCalls, clock };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PostgresStore', () => {
  let ctx: ReturnType<typeof createMockContext>;
  let store: PostgresStore;

  beforeEach(() => {
    ctx = createMockContext();
    store = new PostgresStore({ pool: ctx.pool });
  });

  // -----------------------------------------------------------------------
  // ensureTable
  // -----------------------------------------------------------------------

  describe('ensureTable', () => {
    it('calls CREATE TABLE IF NOT EXISTS', async () => {
      await store.ensureTable();

      // Written to the pool (no client acquired)
      const createQueries = ctx.queries.filter(
        (q) => q.target === 'pool' && q.text.includes('CREATE TABLE'),
      );
      expect(createQueries).toHaveLength(1);
      expect(createQueries[0]!.text).toContain('CREATE TABLE IF NOT EXISTS');
      expect(createQueries[0]!.text).toContain('throttlekit_state');
    });

    it('accepts a custom tableName', async () => {
      const customStore = new PostgresStore({
        pool: ctx.pool,
        tableName: 'my_custom_table',
      });
      await customStore.ensureTable();

      const createQueries = ctx.queries.filter(
        (q) => q.target === 'pool' && q.text.includes('CREATE TABLE'),
      );
      expect(createQueries).toHaveLength(1);
      expect(createQueries[0]!.text).toContain('my_custom_table');
    });
  });

  // -----------------------------------------------------------------------
  // apply
  // -----------------------------------------------------------------------

  describe('apply', () => {
    it('creates new entry when key does not exist', async () => {
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

      // Should have acquired a client, run a transaction with advisory lock
      expect(ctx.pool.connect).toHaveBeenCalledTimes(1);
      expect(ctx.client.query).toHaveBeenCalledWith('BEGIN');
      expect(ctx.client.query).toHaveBeenCalledWith(
        expect.stringContaining('pg_advisory_xact_lock'),
        ['new-key'],
      );
      expect(ctx.client.query).toHaveBeenCalledWith(
        expect.stringContaining('COMMIT'),
      );
      expect(ctx.client.release).toHaveBeenCalledTimes(1);

      // State should be stored
      const stored = ctx.rows.get('new-key');
      expect(stored).toBeDefined();
      expect(stored!.state).toEqual({ count: 1 });
      expect(stored!.expiresAt).toBeGreaterThan(Date.now());
    });

    it('reads and updates existing state', async () => {
      // Seed existing state
      ctx.rows.set('existing-key', {
        state: { count: 5 },
        expiresAt: Date.now() + 60_000,
      });

      const result = await store.apply<CounterState, number>(
        'existing-key',
        60_000,
        (prev) => {
          expect(prev).toEqual({ count: 5 });
          const state: CounterState = { count: prev!.count + 1 };
          return { state, result: state.count };
        },
      );

      expect(result).toBe(6);

      // Verify UPSERT was called with updated state
      const upsertQuery = ctx.queries.find(
        (q) => q.target === 'client' && q.text.includes('INSERT'),
      );
      expect(upsertQuery).toBeDefined();
      expect(upsertQuery!.values?.[1]).toBe(JSON.stringify({ count: 6 }));
    });

    it('ignores expired state', async () => {
      // Seed expired state
      ctx.rows.set('stale-key', {
        state: { count: 99 },
        expiresAt: Date.now() - 1,
      });

      const result = await store.apply<CounterState, number>(
        'stale-key',
        60_000,
        (prev) => {
          // Should receive null because the stored entry is expired
          expect(prev).toBeNull();
          const state: CounterState = { count: 1 };
          return { state, result: 1 };
        },
      );

      expect(result).toBe(1);
    });

    it('rolls back on error and releases client', async () => {
      const expected = new Error('boom');

      await expect(
        store.apply<CounterState, boolean>('fail-key', 60_000, () => {
          throw expected;
        }),
      ).rejects.toThrow('boom');

      // Should have rolled back
      expect(ctx.client.query).toHaveBeenCalledWith('ROLLBACK');

      // Client should be released even after error
      expect(ctx.client.release).toHaveBeenCalledTimes(1);
    });

    it('acquires pg_advisory_xact_lock for the key', async () => {
      await store.apply<CounterState, number>(
        'lock-key',
        60_000,
        (prev) => {
          const state: CounterState = { count: (prev?.count ?? 0) + 1 };
          return { state, result: state.count };
        },
      );

      // Lock should have been acquired for the prefixed key
      expect(ctx.lockCalls).toContain('lock-key');
      expect(ctx.lockCalls).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // get
  // -----------------------------------------------------------------------

  describe('get', () => {
    it('returns stored state', async () => {
      ctx.rows.set('find-me', {
        state: { count: 42 },
        expiresAt: Date.now() + 60_000,
      });

      const result = await store.get<CounterState>('find-me');
      expect(result).toEqual({ count: 42 });
    });

    it('returns null for missing key', async () => {
      const result = await store.get<CounterState>('missing');
      expect(result).toBeNull();
    });

    it('returns null for expired state', async () => {
      ctx.rows.set('expired', {
        state: { count: 1 },
        expiresAt: Date.now() - 1,
      });

      const result = await store.get<CounterState>('expired');
      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // set
  // -----------------------------------------------------------------------

  describe('set', () => {
    it('upserts state with TTL', async () => {
      await store.set('ttl-key', { value: 100 }, 30_000);

      const row = ctx.rows.get('ttl-key');
      expect(row).toBeDefined();
      expect(row!.state).toEqual({ value: 100 });
      expect(row!.expiresAt).toBeGreaterThan(Date.now());

      // UPSERT query should have been sent to the pool
      const upsertQuery = ctx.queries.find(
        (q) => q.target === 'pool' && q.text.includes('INSERT'),
      );
      expect(upsertQuery).toBeDefined();
      expect(upsertQuery!.values?.[0]).toBe('ttl-key');
      expect(upsertQuery!.values?.[1]).toBe(JSON.stringify({ value: 100 }));
      expect(upsertQuery!.values?.[2]).toBe(30_000);
    });

    it('upserts state without TTL (far-future expires_at)', async () => {
      await store.set('no-ttl-key', { value: 200 });

      const row = ctx.rows.get('no-ttl-key');
      expect(row).toBeDefined();
      expect(row!.state).toEqual({ value: 200 });
      // 9999999999999 is the far-future sentinel
      expect(row!.expiresAt).toBe(9999999999999);
    });

    it('overwrites existing state', async () => {
      ctx.rows.set('overwrite', {
        state: { old: true },
        expiresAt: Date.now() + 60_000,
      });

      await store.set('overwrite', { new: true }, 30_000);

      const row = ctx.rows.get('overwrite');
      expect(row!.state).toEqual({ new: true });
    });
  });

  // -----------------------------------------------------------------------
  // delete
  // -----------------------------------------------------------------------

  describe('delete', () => {
    it('removes state from the table', async () => {
      ctx.rows.set('delete-me', {
        state: { temp: true },
        expiresAt: Date.now() + 60_000,
      });

      await store.delete('delete-me');

      expect(ctx.rows.has('delete-me')).toBe(false);

      const deleteQuery = ctx.queries.find(
        (q) => q.target === 'pool' && q.text.toUpperCase().startsWith('DELETE'),
      );
      expect(deleteQuery).toBeDefined();
      expect(deleteQuery!.values?.[0]).toBe('delete-me');
    });

    it('is idempotent for missing key', async () => {
      await expect(store.delete('nada')).resolves.toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // prefix
  // -----------------------------------------------------------------------

  describe('prefix option', () => {
    it('namespaces keys correctly for all operations', async () => {
      const prefixed = new PostgresStore({
        pool: ctx.pool,
        prefix: 'app1:',
      });

      // apply
      await prefixed.apply<CounterState, boolean>(
        'my-key',
        60_000,
        (prev) => {
          const state: CounterState = { count: (prev?.count ?? 0) + 1 };
          return { state, result: true };
        },
      );

      expect(ctx.rows.has('app1:my-key')).toBe(true);
      expect(ctx.rows.has('my-key')).toBe(false);

      // Lock should use prefixed key
      expect(ctx.lockCalls).toContain('app1:my-key');

      // get
      const got = await prefixed.get<CounterState>('my-key');
      expect(got).toEqual({ count: 1 });

      // set
      await prefixed.set('my-key', { count: 42 }, 60_000);
      expect(ctx.rows.get('app1:my-key')!.state).toEqual({ count: 42 });

      // delete
      await prefixed.delete('my-key');
      expect(ctx.rows.has('app1:my-key')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Concurrent apply — both succeed, states merge
  // -----------------------------------------------------------------------

  describe('concurrent apply on same key', () => {
    it('both calls acquire the advisory lock and both succeed', async () => {
      // Run two concurrent apply calls on the same key.
      // In the mock, JavaScript's event loop prevents true interleaving, but
      // we verify that pg_advisory_xact_lock is called for EACH apply and
      // both ultimately succeed.
      const [r1, r2] = await Promise.all([
        store.apply<CounterState, number>('concurrent-key', 60_000, (prev) => {
          const state: CounterState = { count: (prev?.count ?? 0) + 1 };
          return { state, result: state.count };
        }),
        store.apply<CounterState, number>('concurrent-key', 60_000, (prev) => {
          const state: CounterState = { count: (prev?.count ?? 0) + 1 };
          return { state, result: state.count };
        }),
      ]);

      // Both calls should succeed (both return a number)
      expect(typeof r1).toBe('number');
      expect(typeof r2).toBe('number');

      // Advisory lock should have been acquired twice for the same key,
      // proving the store issues the lock call for concurrent invocations
      const lockCallsForKey = ctx.lockCalls.filter(
        (k) => k === 'concurrent-key',
      );
      expect(lockCallsForKey).toHaveLength(2);

      // Both clients should have been released
      expect(ctx.client.release).toHaveBeenCalledTimes(2);
    });
  });
});
