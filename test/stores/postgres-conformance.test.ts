import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runStoreConformance } from '../testkit/store-conformance.js';
import { PostgresStore } from '../../src/stores/postgres.js';
import type { Store } from '../../src/core/types.js';
import type { PgPool } from '../../src/stores/postgres.js';

const TEST_TABLE = 'throttlekit_conformance_test';
const POSTGRES_URL = process.env.POSTGRES_URL;

let skip = false;
let skipReason = '';
let pool: PgPool | null = null;
let store: Store | null = null;

describe('Postgres Live Conformance', () => {
  beforeAll(async () => {
    if (!POSTGRES_URL) {
      skip = true;
      skipReason = 'POSTGRES_URL is not set';
      console.warn(`⚠️  ${skipReason} — skipping Postgres live conformance tests`);
      return;
    }

    try {
      // pg is an optional dependency — dynamic import
      const pgModule: any = await import('pg' as any);
      const Pool = pgModule.Pool ?? pgModule.default?.Pool;
      if (!Pool) throw new Error('pg module does not export Pool');

      const livePool: PgPool = new Pool({ connectionString: POSTGRES_URL });
      pool = livePool;

      // Verify connectivity
      const result = await livePool.query('SELECT 1 as ping');
      if (!result.rows.length || (result.rows[0] as any).ping !== 1) {
        throw new Error('ping failed');
      }

      store = new PostgresStore({ pool: livePool, tableName: TEST_TABLE });
      await (store as PostgresStore).ensureTable();
    } catch (err: any) {
      skip = true;
      skipReason = `No Postgres at POSTGRES_URL — ${err?.message ?? String(err)}`;
      console.warn(`⚠️  ${skipReason} — skipping Postgres live conformance tests`);
      // Release pool if created
      if (pool) {
        try { await (pool as any).end?.(); } catch { /* swallow */ }
        pool = null;
      }
    }
  });

  afterAll(async () => {
    if (pool) {
      try {
        await pool.query(`DROP TABLE IF EXISTS ${TEST_TABLE}`);
        await (pool as any).end?.();
      } catch {
        // Best-effort cleanup
      }
    }
  });

  it.skipIf(() => skip)('placeholder to ensure describe runs', () => {
    expect(skipReason).toBe('');
  });

  if (!skip && store && pool) {
    runStoreConformance({
      name: 'PostgresStore',
      createStore: () => {
        // Reuse the same pool and store instance
        return store!;
      },
      cleanup: async () => {
        if (pool) {
          try {
            await pool.query(`TRUNCATE TABLE ${TEST_TABLE}`);
          } catch {
            // Best-effort cleanup
          }
        }
      },
    });
  }
});
