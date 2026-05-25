import type { Clock, Store } from '../core/types.js';

interface MemoryEntry {
  value: unknown;
  expiresAt: number;
}

export interface MemoryStoreOptions {
  /** Clock for time measurement (defaults to internal Date.now) */
  clock?: Clock;
  /** Default TTL in milliseconds */
  defaultTtlMs?: number;
}

/**
 * In-memory store with per-key promise-chain mutex.
 * Zero required dependencies.
 */
export class MemoryStore implements Store {
  private store = new Map<string, MemoryEntry>();
  private locks = new Map<string, Promise<void>>();
  private clock: Clock;
  private defaultTtlMs: number;

  constructor(options: MemoryStoreOptions = {}) {
    this.clock = options.clock ?? { now: () => Date.now() };
    this.defaultTtlMs = options.defaultTtlMs ?? 60_000;
  }

  async apply<S, T>(
    key: string,
    ttlMs: number,
    transform: (state: S | null) => { state: S; result: T }
  ): Promise<T> {
    await this.acquireLock(key);
    try {
      const entry = this.store.get(key);
      const currentState =
        entry && entry.expiresAt > this.clock.now()
          ? (entry.value as S)
          : null;
      const { state: newState, result } = transform(currentState);
      this.store.set(key, {
        value: newState,
        expiresAt: this.clock.now() + ttlMs,
      });
      return result;
    } finally {
      this.releaseLock(key);
    }
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry || entry.expiresAt <= this.clock.now()) {
      return null;
    }
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: this.clock.now() + (ttlMs ?? this.defaultTtlMs),
    });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  /** Per-key mutex using promise chaining */
  private acquireLock(key: string): Promise<void> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(
      () => {},
      () => {}
    ); // Swallow rejection so chain continues
    this.locks.set(key, next);
    return prev;
  }

  private releaseLock(key: string): void {
    // Lock auto-releases as the promise chain resolves.
    // Optional: periodic cleanup of resolved promises could be added here.
  }
}
