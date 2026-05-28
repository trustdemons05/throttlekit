/**
 * D1Store — Cloudflare Workers D1 (SQLite at the edge) backed store.
 *
 * Uses duck-typed local interfaces instead of importing Cloudflare SDK types.
 * D1 is serverless SQLite accessible from Cloudflare Workers. It does NOT
 * support advisory locks or multi-statement transactions with interleaved
 * application logic. However, `apply()` implements Optimistic Concurrency
 * Control (OCC) with a `version` column to provide per-key linearisability
 * without relying on D1's single-writer-per-database model alone.
 *
 * @module
 */

import type { Store } from '../core/types.js';

// ---------------------------------------------------------------------------
// Duck-typed Cloudflare D1 interfaces
// ---------------------------------------------------------------------------

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  exec(query: string): Promise<D1ExecResult>;
  batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T>(): Promise<T | null>;
  run(): Promise<D1Result<unknown>>;
  all<T>(): Promise<D1Result<T>>;
}

export interface D1Result<T> {
  results: T[];
  success: boolean;
  meta: Record<string, unknown>;
}

export interface D1ExecResult {
  count: number;
  duration: number;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface D1StoreOptions {
  /** Duck-typed D1Database instance (obtained from a Cloudflare Worker binding) */
  db: D1Database;
  /** SQLite table name to use (default: 'throttlekit_state') */
  tableName?: string;
  /** Optional key prefix for namespace isolation (default: '') */
  prefix?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TABLE = 'throttlekit_state';

/**
 * Fallback expiry used when no TTL is provided to `set()`.
 * Approximately 1000 years from epoch — effectively "never expires".
 */
const FAR_FUTURE_MS = 31_536_000_000_000;

// ---------------------------------------------------------------------------
// D1Store
// ---------------------------------------------------------------------------

/**
 * Store implementation backed by Cloudflare Workers D1 (SQLite at the edge).
 *
 * ## Concurrency control
 *
 * `apply()` uses **Optimistic Concurrency Control (OCC)** with a `version`
 * column to detect concurrent modifications. Each write includes a version
 * check (`WHERE version = ?`), and the method retries up to 5 times if a
 * conflict is detected. This provides per-key linearisability without
 * requiring D1 advisory locks or application-logic-interleaved transactions.
 *
 * If you need guaranteed single-threaded execution without retries, consider
 * `DurableObjectStore` instead (each key maps to its own Durable Object).
 *
 * ```ts
 * // In a Cloudflare Worker:
 * import { D1Store } from 'throttlekit/stores/cloudflare-d1';
 *
 * // env.DB is your D1 database binding
 * const store = new D1Store({ db: env.DB });
 * await store.ensureTable();
 * ```
 */
export class D1Store implements Store {
  private db: D1Database;
  private tableName: string;
  private prefix: string;

  constructor(options: D1StoreOptions) {
    this.db = options.db;
    this.tableName = options.tableName ?? DEFAULT_TABLE;
    this.prefix = options.prefix ?? '';
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /** Prefix a user-facing key with the configured prefix. */
  private prefixedKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  // -----------------------------------------------------------------------
  // Schema management
  // -----------------------------------------------------------------------

  /**
   * Create the state table if it does not already exist.
   *
   * Safe to call repeatedly — `IF NOT EXISTS` makes it idempotent.
   * Should be called at worker startup before any rate-limit operations.
   */
  async ensureTable(): Promise<void> {
    await this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${this.tableName} (
        key TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        version INTEGER DEFAULT 0
      )`,
    );
  }

  // -----------------------------------------------------------------------
  // Store interface
  // -----------------------------------------------------------------------

  /**
   * Read-modify-write for a rate-limit key.
   *
   * Uses Optimistic Concurrency Control (OCC) with a `version` column to
   * detect concurrent modifications. The method performs a CAS (compare-and-
   * swap) loop:
   *
   * 1. SELECT current (non-expired) state and version
   * 2. Run `transform` in application memory
   * 3. Try UPDATE with WHERE version = currentVersion
   * 4. If the UPDATE affected no rows, another writer modified the key —
   *    retry from step 1 (up to `MAX_RETRIES` times)
   * 5. If the key does not exist, attempt INSERT — if the INSERT fails
   *    due to a UNIQUE constraint (another writer inserted first), retry
   *
   * This provides per-key linearisability without relying on D1's
   * single-writer-per-database model alone.
   */
  async apply<S, T>(
    key: string,
    ttlMs: number,
    transform: (state: S | null) => { state: S; result: T },
  ): Promise<T> {
    const pKey = this.prefixedKey(key);
    const now = Date.now();
    const maxRetries = 500;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // 1. Read current (non-expired) state with version
      const row = await this.db
        .prepare(
          `SELECT state, version FROM ${this.tableName} WHERE key = ? AND expires_at > ?`,
        )
        .bind(pKey, now)
        .first<{ state: string; version: number }>();

      const currentState: S | null = row ? (JSON.parse(row.state) as S) : null;

      // 2. Run transform in application memory
      const { state: newState, result } = transform(currentState);

      if (row) {
        // 3. Existing non-expired row — try atomic UPDATE with version check
        const currentVersion = row.version;
        const updateResult = await this.db
          .prepare(
            `UPDATE ${this.tableName} SET state = ?, version = version + 1, expires_at = ? WHERE key = ? AND version = ?`,
          )
          .bind(JSON.stringify(newState), now + ttlMs, pKey, currentVersion)
          .run();

        // 4. Verify the UPDATE affected a row. Some drivers report this via meta.changes.
        if (updateResult.meta?.changes === 1) {
          return result;
        }

        // If the driver explicitly reports no changes, skip the re-read and retry.
        if (updateResult.meta && 'changes' in updateResult.meta && updateResult.meta.changes === 0) {
          continue;
        }

        // Fallback: re-read to verify our UPDATE took effect
        const after = await this.db
          .prepare(
            `SELECT state, version FROM ${this.tableName} WHERE key = ?`,
          )
          .bind(pKey)
          .first<{ state: string; version: number }>();

        if (
          after &&
          after.version !== currentVersion &&
          after.state === JSON.stringify(newState)
        ) {
          return result;
        }
        // Otherwise: collision detected — another writer modified the row
        // before our re-read (or our UPDATE was silently lost). Retry.
      } else {
        // 5. No non-expired row — could be a missing key or an expired entry.
        // Read any existing row (even if expired) to check.
        const existing = await this.db
          .prepare(
            `SELECT state, version FROM ${this.tableName} WHERE key = ?`,
          )
          .bind(pKey)
          .first<{ state: string; version: number }>();

        if (existing) {
          // 5a. Key exists but is expired — try UPDATE with version check
          const updateResult = await this.db
            .prepare(
              `UPDATE ${this.tableName} SET state = ?, version = version + 1, expires_at = ? WHERE key = ? AND version = ?`,
            )
            .bind(JSON.stringify(newState), now + ttlMs, pKey, existing.version)
            .run();

          if (updateResult.meta?.changes === 1) {
            return result;
          }

          if (updateResult.meta && 'changes' in updateResult.meta && updateResult.meta.changes === 0) {
            continue;
          }

          const after = await this.db
            .prepare(
              `SELECT state, version FROM ${this.tableName} WHERE key = ?`,
            )
            .bind(pKey)
            .first<{ state: string; version: number }>();

          if (
            after &&
            after.version !== existing.version &&
            after.state === JSON.stringify(newState)
          ) {
            return result;
          }
          // Collision — retry
        } else {
          // 5b. Key truly does not exist — try INSERT
          try {
            await this.db
              .prepare(
                `INSERT INTO ${this.tableName} (key, state, expires_at, version) VALUES (?, ?, ?, 1)`,
              )
              .bind(pKey, JSON.stringify(newState), now + ttlMs)
              .run();
            return result;
          } catch (err: unknown) {
            const msg =
              err instanceof Error ? err.message : String(err);
            if (
              msg.includes('UNIQUE constraint failed') ||
              msg.includes('conflict')
            ) {
              // Another writer inserted first — retry
              continue;
            }
            throw err;
          }
        }
      }
    }

    throw new Error('D1Store: max CAS retries exceeded');
  }

  /**
   * Read the stored (non-expired) state for a key.
   *
   * Returns `null` when the key does not exist or has expired.
   */
  async get<T>(key: string): Promise<T | null> {
    const pKey = this.prefixedKey(key);
    const now = Date.now();

    const row = await this.db
      .prepare(
        `SELECT state FROM ${this.tableName} WHERE key = ? AND expires_at > ?`,
      )
      .bind(pKey, now)
      .first<{ state: string }>();

    if (!row) {
      return null;
    }

    return JSON.parse(row.state) as T;
  }

  /**
   * Write a value with an optional TTL.
   *
   * When `ttlMs` is provided the entry expires after that many milliseconds.
   * When omitted the entry is stored with a far-future expiry (~1000 years).
   */
  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const pKey = this.prefixedKey(key);
    const expiresAt =
      ttlMs !== undefined ? Date.now() + ttlMs : Date.now() + FAR_FUTURE_MS;

    await this.db
      .prepare(
        `INSERT OR REPLACE INTO ${this.tableName} (key, state, expires_at, version) VALUES (?, ?, ?, 1)`,
      )
      .bind(pKey, JSON.stringify(value), expiresAt)
      .run();
  }

  /**
   * Remove a key and its state from the table.
   */
  async delete(key: string): Promise<void> {
    const pKey = this.prefixedKey(key);

    await this.db
      .prepare(`DELETE FROM ${this.tableName} WHERE key = ?`)
      .bind(pKey)
      .run();
  }
}
