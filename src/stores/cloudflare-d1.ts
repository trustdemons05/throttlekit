/**
 * D1Store — Cloudflare Workers D1 (SQLite at the edge) backed store.
 *
 * Uses duck-typed local interfaces instead of importing Cloudflare SDK types.
 * D1 is serverless SQLite accessible from Cloudflare Workers. It does NOT
 * support advisory locks or multi-statement transactions with interleaved
 * application logic, so `apply()` performs a read-then-write pattern without
 * strong atomicity guarantees. D1's single-writer-per-database model provides
 * some serialisation in practice.
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
 * ## Atomicity caveat
 *
 * D1 does **not** support advisory locks or application-logic-interleaved
 * transactions. The `apply()` method therefore executes a **read-then-write**
 * sequence without strong atomicity guarantees. In practice, D1's
 * single-writer-per-database model serialises writes at the SQLite level,
 * which mitigates but does not eliminate race conditions.
 *
 * If you need strict per-key serialisation, consider `DurableObjectStore`
 * instead (each key maps to its own Durable Object, guaranteeing single-
 * threaded execution).
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
        expires_at INTEGER NOT NULL
      )`,
    );
  }

  // -----------------------------------------------------------------------
  // Store interface
  // -----------------------------------------------------------------------

  /**
   * Read-modify-write for a rate-limit key.
   *
   * Because D1 does not support advisory locks or interleaved transaction
   * logic, this method uses a two-step read-then-write approach:
   *
   * 1. SELECT current (non-expired) state
   * 2. Run `transform` in application memory
   * 3. INSERT OR REPLACE the new state
   *
   * D1's single-writer-per-database provides some serialisation, but
   * concurrent `apply()` calls on the **same** key may interleave under
   * rare edge conditions (e.g., concurrent Worker requests routed to
   * different isolates).
   */
  async apply<S, T>(
    key: string,
    ttlMs: number,
    transform: (state: S | null) => { state: S; result: T },
  ): Promise<T> {
    const pKey = this.prefixedKey(key);
    const now = Date.now();

    // 1. Read current (non-expired) state
    const row = await this.db
      .prepare(
        `SELECT state FROM ${this.tableName} WHERE key = ? AND expires_at > ?`,
      )
      .bind(pKey, now)
      .first<{ state: string }>();

    // 2. Parse current state (null if missing or expired)
    const currentState: S | null = row ? (JSON.parse(row.state) as S) : null;

    // 3. Run transform in application memory
    const { state: newState, result } = transform(currentState);

    // 4. Persist new state via batch() for pseudo-atomic write execution
    const writeStmt = this.db
      .prepare(
        `INSERT OR REPLACE INTO ${this.tableName} (key, state, expires_at) VALUES (?, ?, ?)`,
      )
      .bind(pKey, JSON.stringify(newState), now + ttlMs);
    await this.db.batch([writeStmt]);

    return result;
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
        `INSERT OR REPLACE INTO ${this.tableName} (key, state, expires_at) VALUES (?, ?, ?)`,
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
