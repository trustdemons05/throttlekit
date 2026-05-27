/**
 * KVStore — Cloudflare KV-backed store.
 *
 * ⚠️ WARNING: Cloudflare KV is eventually consistent.
 * This store does NOT guarantee atomicity of apply().
 * Use only for best-effort global rate limits where slight overshoot is acceptable.
 * For strict rate limiting, use DurableObjectStore or D1Store.
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
}

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

export class KVStore implements Store {
  private kv: KVNamespace;
  private prefix: string;

  constructor(options: KVStoreOptions) {
    this.kv = options.kv;
    this.prefix = options.prefix ?? '';
  }

  private prefixedKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  async apply<S, T>(
    key: string,
    ttlMs: number,
    transform: (state: S | null) => { state: S; result: T },
  ): Promise<T> {
    const raw = await this.kv.get(this.prefixedKey(key), { type: 'text' });
    const currentState: S | null = raw ? (JSON.parse(raw) as S) : null;
    const { state: newState, result } = transform(currentState);
    await this.kv.put(this.prefixedKey(key), JSON.stringify(newState), {
      expirationTtl: Math.ceil(ttlMs / 1000),
    });
    return result;
  }

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.kv.get(this.prefixedKey(key), { type: 'text' });
    return raw ? (JSON.parse(raw) as T) : null;
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const opts = ttlMs !== undefined ? { expirationTtl: Math.ceil(ttlMs / 1000) } : undefined;
    await this.kv.put(this.prefixedKey(key), JSON.stringify(value), opts);
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(this.prefixedKey(key));
  }
}
