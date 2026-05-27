import type { Store } from '../core/types.js';

// ---------------------------------------------------------------------------
// Duck-typed pg interfaces (zero runtime dependency on 'pg')
// ---------------------------------------------------------------------------

export interface PgPool {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  connect(): Promise<PgClient>;
}

export interface PgClient {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}

export interface PostgresStoreOptions {
  /** Duck-typed pg.Pool instance */
  pool: PgPool;
  /** Optional key namespace prefix (default '') */
  prefix?: string;
  /** Table name to use (default 'throttlekit_state') */
  tableName?: string;
}

// ---------------------------------------------------------------------------
// PostgresStore
// ---------------------------------------------------------------------------

/**
 * PostgreSQL-backed Store implementation for teams without Redis.
 *
 * Uses `pg_advisory_xact_lock` for per-key serialization inside a database
 * transaction so that concurrent `apply()` calls on the same key do not
 * interleave — exactly-once semantics guaranteed by PostgreSQL itself.
 *
 * ```ts
 * import pg from 'pg';
 * const pool = new pg.Pool({ connectionString: 'postgres://...' });
 * const store = new PostgresStore({ pool });
 * await store.ensureTable();
 * ```
 *
 * All `get` / `set` / `delete` methods use the pool directly (no transaction)
 * while `apply` acquires a dedicated client, runs a full transaction, and
 * releases it on completion.
 */
export class PostgresStore implements Store {
  private pool: PgPool;
  private prefix: string;
  private tableName: string;

  constructor(options: PostgresStoreOptions) {
    this.pool = options.pool;
    this.prefix = options.prefix ?? '';
    this.tableName = options.tableName ?? 'throttlekit_state';
  }

  /**
   * Create the state table if it does not already exist.
   *
   * Safe to call repeatedly — the `IF NOT EXISTS` clause makes it idempotent.
   */
  async ensureTable(): Promise<void> {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ${this.tableName} (
        key TEXT PRIMARY KEY,
        state JSONB NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      )`,
    );
  }

  /**
   * Build the prefixed key string.
   */
  private prefixedKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  /**
   * Atomic read-modify-write inside a serialised PostgreSQL transaction.
   *
   * 1. Acquires a dedicated client from the pool
   * 2. `BEGIN`
   * 3. Acquires a per-key advisory lock (`pg_advisory_xact_lock`)
   * 4. Reads current (non-expired) state
   * 5. Calls `transform` to produce new state + result
   * 6. UPSERTs the new state
   * 7. `COMMIT`
   * 8. Releases client back to the pool
   *
   * On any error the transaction is rolled back, the client is released, and
   * the original error is re-thrown.
   */
  async apply<S, T>(
    key: string,
    ttlMs: number,
    transform: (state: S | null) => { state: S; result: T },
  ): Promise<T> {
    const pKey = this.prefixedKey(key);
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // Per-key serialization — PostgreSQL ensures only one transaction at a
      // time holds this lock for the same key.
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`,
        [pKey],
      );

      // Read current non-expired state
      const readResult = await client.query(
        `SELECT state FROM ${this.tableName} WHERE key = $1 AND expires_at > NOW()`,
        [pKey],
      );

      const currentState: S | null =
        readResult.rows.length > 0
          ? (readResult.rows[0] as Record<string, unknown>).state as S
          : null;

      const { state: newState, result } = transform(currentState);

      // UPSERT — insert or update on conflict
      await client.query(
        `INSERT INTO ${this.tableName} (key, state, expires_at)
         VALUES ($1, $2::jsonb, NOW() + $3::bigint * INTERVAL '1 millisecond')
         ON CONFLICT (key) DO UPDATE SET
           state = EXCLUDED.state,
           expires_at = EXCLUDED.expires_at`,
        [pKey, JSON.stringify(newState), ttlMs],
      );

      await client.query('COMMIT');
      return result;
    } catch (err: unknown) {
      await client.query('ROLLBACK').catch(() => {
        /* swallow rollback errors */
      });
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Read the stored (non-expired) state for a key, or `null` when it does not
   * exist or has expired.
   */
  async get<T>(key: string): Promise<T | null> {
    const pKey = this.prefixedKey(key);
    const result = await this.pool.query(
      `SELECT state FROM ${this.tableName} WHERE key = $1 AND expires_at > NOW()`,
      [pKey],
    );

    if (result.rows.length === 0) {
      return null;
    }

    return (result.rows[0] as Record<string, unknown>).state as T;
  }

  /**
   * Write a value with an optional TTL.
   *
   * When `ttlMs` is provided the entry expires after that many milliseconds.
   * When omitted the entry is stored with a "never expires" sentinel date.
   */
  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const pKey = this.prefixedKey(key);

    if (ttlMs !== undefined) {
      await this.pool.query(
        `INSERT INTO ${this.tableName} (key, state, expires_at)
         VALUES ($1, $2::jsonb, NOW() + $3::bigint * INTERVAL '1 millisecond')
         ON CONFLICT (key) DO UPDATE SET
           state = EXCLUDED.state,
           expires_at = EXCLUDED.expires_at`,
        [pKey, JSON.stringify(value), ttlMs],
      );
    } else {
      await this.pool.query(
        `INSERT INTO ${this.tableName} (key, state, expires_at)
         VALUES ($1, $2::jsonb, '9999-12-31T23:59:59Z')
         ON CONFLICT (key) DO UPDATE SET
           state = EXCLUDED.state,
           expires_at = EXCLUDED.expires_at`,
        [pKey, JSON.stringify(value)],
      );
    }
  }

  /**
   * Remove a key and its state from the table.
   */
  async delete(key: string): Promise<void> {
    const pKey = this.prefixedKey(key);
    await this.pool.query(
      `DELETE FROM ${this.tableName} WHERE key = $1`,
      [pKey],
    );
  }
}
