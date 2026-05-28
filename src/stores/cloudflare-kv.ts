/**
 * KVStore — Cloudflare KV-backed store.
 *
 * ⚠️ CLOUDFLARE KV IS EVENTUALLY CONSISTENT.
 * Reads can return stale data for up to 60 seconds after a write.
 * This store includes a short-lived local write cache (1 second TTL)
 * to mitigate self-stale reads within the same process.
 *
 * Do NOT use KVStore for strict, security-critical rate limiting.
 * For strong consistency, use DurableObjectStore or D1Store.
 */

import type { Store } from '../core/types.js';

// ---------------------------------------------------------------------------
// Duck-typed Cloudflare KV interfaces
// ---------------------------------------------------------------------------

export interface KVNamespace {
  get(key: string, options?: { type?: 'text' | 'json' }): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface KVStoreOptions {
  kv: KVNamespace;
  prefix?: string;
  /**
   * When true, logs a one-time warning about KV's eventual consistency.
   * Default: true in production-like environments, but for simplicity default false.
   */
  consistencyWarning?: boolean;
}

/**
 * ⚠️ Cloudflare KV is eventually consistent (up to 60s propagation).
 * Do NOT use KVStore for strict, security-critical rate limiting.
 * Consider DurableObjectStore or D1Store for strong consistency.
 */
export const KV_CONSISTENCY_WARNING = 'Cloudflare KV is eventually consistent. Reads may return stale data for up to 60 seconds.';

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

export class KVStore implements Store {
  private kv: KVNamespace;
  private prefix: string;
  private writeCache = new Map<string, { value: string; expiresAt: number }>();
  private exactTtl = new Map<string, number>();
  private warningLogged = false;
  /** Per-key promise chain mutex so concurrent apply() calls are serialised. */
  private locks = new Map<string, Promise<void>>();

  constructor(options: KVStoreOptions) {
    this.kv = options.kv;
    this.prefix = options.prefix ?? '';
    if (options.consistencyWarning !== false) {
      this.logConsistencyWarning();
    }
  }

  private logConsistencyWarning(): void {
    if (!this.warningLogged) {
      this.warningLogged = true;
      console.warn(KV_CONSISTENCY_WARNING);
    }
  }

  private getCached(key: string): string | null {
    const entry = this.writeCache.get(key);
    if (entry && entry.expiresAt > Date.now()) {
      return entry.value;
    }
    this.writeCache.delete(key);
    return null;
  }

  private setCached(key: string, value: string, ttlMs: number): void {
    // Cache for min(ttlMs, 1000) to avoid self-stale reads
    this.writeCache.set(key, { value, expiresAt: Date.now() + Math.min(ttlMs, 1000) });
  }

  private prefixedKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  async apply<S, T>(
    key: string,
    ttlMs: number,
    transform: (state: S | null) => { state: S; result: T },
  ): Promise<T> {
    const prefixed = this.prefixedKey(key);
    const prev = this.locks.get(prefixed) ?? Promise.resolve();
    const work = prev.then(async () => {
      // Check local cache first to avoid self-stale reads
      const cached = this.getCached(prefixed);
      const raw = cached !== null ? cached : await this.kv.get(prefixed, { type: 'text' });
      const currentState: S | null = raw ? (JSON.parse(raw) as S) : null;
      const { state: newState, result } = transform(currentState);
      const serialized = JSON.stringify(newState);
      await this.kv.put(prefixed, serialized, {
        expirationTtl: Math.ceil(ttlMs / 1000),
      });
      // Cache the written value to avoid self-stale reads
      this.setCached(prefixed, serialized, ttlMs);
      this.exactTtl.set(prefixed, Date.now() + ttlMs);
      return result;
    });
    this.locks.set(prefixed, work.then(() => {}, () => {}));
    return work;
  }

  async get<T>(key: string): Promise<T | null> {
    const prefixed = this.prefixedKey(key);
    // Check exact TTL first (compensates for KV's coarse second-level TTLs)
    const exactExpiry = this.exactTtl.get(prefixed);
    if (exactExpiry !== undefined && exactExpiry <= Date.now()) {
      return null;
    }
    // Check local cache first to avoid self-stale reads
    const cached = this.getCached(prefixed);
    const raw = cached !== null ? cached : await this.kv.get(prefixed, { type: 'text' });
    return raw ? (JSON.parse(raw) as T) : null;
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const prefixed = this.prefixedKey(key);
    const serialized = JSON.stringify(value);
    const opts = ttlMs !== undefined ? { expirationTtl: Math.ceil(ttlMs / 1000) } : undefined;
    await this.kv.put(prefixed, serialized, opts);
    // Cache the written value to avoid self-stale reads
    if (ttlMs !== undefined) {
      this.setCached(prefixed, serialized, ttlMs);
      this.exactTtl.set(prefixed, Date.now() + ttlMs);
    } else {
      // If no TTL provided, cache for default max of 1 second
      this.setCached(prefixed, serialized, 1000);
      this.exactTtl.delete(prefixed);
    }
  }

  async delete(key: string): Promise<void> {
    const prefixed = this.prefixedKey(key);
    await this.kv.delete(prefixed);
    this.writeCache.delete(prefixed);
    this.exactTtl.delete(prefixed);
  }
}
