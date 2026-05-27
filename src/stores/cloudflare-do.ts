/**
 * DurableObjectStore — Cloudflare Workers Durable Object backed store.
 *
 * Uses duck-typed local interfaces instead of importing Cloudflare SDK types.
 * Each key maps to a unique Durable Object id via idFromName, ensuring
 * per-key single-threaded execution and atomic read-modify-write semantics.
 *
 * @module
 */

import type { Store } from '../core/types.js';

// ---------------------------------------------------------------------------
// Duck-typed Cloudflare Durable Object interfaces
// ---------------------------------------------------------------------------

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

export interface DurableObjectId {
  toString(): string;
}

export interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectState {
  storage: DurableObjectStorage;
}

export interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  setAlarm(scheduledTime: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Entry persisted inside the Durable Object. */
interface StoredEntry {
  state: unknown;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface DurableObjectStoreOptions {
  /** Durable Object namespace binding */
  namespace: DurableObjectNamespace;
  /** Optional key prefix for namespace isolation */
  prefix?: string;
}

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

/**
 * Store implementation backed by Cloudflare Workers Durable Objects.
 *
 * Each rate-limit key is assigned to its own Durable Object instance,
 * guaranteeing serialised, single-threaded read-modify-write operations
 * without external locks.
 */
export class DurableObjectStore implements Store {
  private namespace: DurableObjectNamespace;
  private prefix: string;
  /** Per-key promise chain mutex so concurrent apply() calls are serialised. */
  private locks = new Map<string, Promise<void>>();

  constructor(options: DurableObjectStoreOptions) {
    this.namespace = options.namespace;
    this.prefix = options.prefix ?? '';
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /** Prefix a user-facing key with the configured prefix. */
  private prefixedKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  /** Obtain the Durable Object stub responsible for the given key. */
  private getStub(key: string): DurableObjectStub {
    const id = this.namespace.idFromName(key);
    return this.namespace.get(id);
  }

  // -----------------------------------------------------------------------
  // Store interface
  // -----------------------------------------------------------------------

  async apply<S, T>(
    key: string,
    ttlMs: number,
    transform: (state: S | null) => { state: S; result: T },
  ): Promise<T> {
    const prefixed = this.prefixedKey(key);

    // Per-key mutex using promise chaining.
    // Each apply() waits for the previous apply() to that key to complete.
    const prev = this.locks.get(prefixed) ?? Promise.resolve();
    const work = prev.then(async () => {
      const currentState = await this.get<S>(key);
      const { state: newState, result } = transform(currentState);
      await this.set(key, newState, ttlMs);
      return result;
    });
    // Chain the lock: next call waits for this one's work to complete.
    // Swallow rejection so the chain stays alive even if a transform throws.
    this.locks.set(prefixed, work.then(() => {}, () => {}));
    return work;
  }

  async get<T>(key: string): Promise<T | null> {
    const stub = this.getStub(this.prefixedKey(key));
    const response = await stub.fetch(
      new Request(`http://do/${this.prefixedKey(key)}`, { method: 'GET' }),
    );
    const data: T | null = (await response.json()) as T | null;
    return data;
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const stub = this.getStub(this.prefixedKey(key));
    const response = await stub.fetch(
      new Request(`http://do/${this.prefixedKey(key)}`, {
        method: 'POST',
        body: JSON.stringify({ state: value, ttlMs: ttlMs ?? 60_000 }),
      }),
    );
    const body = (await response.json()) as { ok: boolean };
    if (!body.ok) {
      throw new Error('DurableObjectStore.set: unexpected response');
    }
  }

  async delete(key: string): Promise<void> {
    const stub = this.getStub(this.prefixedKey(key));
    const response = await stub.fetch(
      new Request(`http://do/${this.prefixedKey(key)}`, { method: 'DELETE' }),
    );
    const body = (await response.json()) as { ok: boolean };
    if (!body.ok) {
      throw new Error('DurableObjectStore.delete: unexpected response');
    }
  }
}

// ---------------------------------------------------------------------------
// Durable Object class
// ---------------------------------------------------------------------------

/**
 * The Durable Object class that powers DurableObjectStore.
 *
 * Handles GET /<key>   → returns the state (or null if expired/missing)
 *         POST /<key>  → stores { state, expiresAt }
 *         DELETE /<key> → removes the entry
 */
export class ThrottleKitDO {
  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const key = url.pathname.slice(1); // strip leading "/"

    if (request.method === 'GET') {
      const data = await this.state.storage.get<StoredEntry>(key);
      if (!data || data.expiresAt <= Date.now()) {
        return Response.json(null);
      }
      return Response.json(data.state);
    }

    if (request.method === 'POST') {
      const body = (await request.json()) as { state: unknown; ttlMs: number };
      await this.state.storage.put<StoredEntry>(key, {
        state: body.state,
        expiresAt: Date.now() + body.ttlMs,
      });
      return Response.json({ ok: true });
    }

    if (request.method === 'DELETE') {
      await this.state.storage.delete(key);
      return Response.json({ ok: true });
    }

    return new Response('Method not allowed', { status: 405 });
  }
}
