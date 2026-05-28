import { runStoreConformance } from '../testkit/store-conformance.js';
import { KVStore } from '../../src/stores/cloudflare-kv.js';
import type { KVNamespace } from '../../src/stores/cloudflare-kv.js';

class MockKVNamespace implements KVNamespace {
  private data = new Map<string, { value: string; expiresAt: number }>();
  async get(key: string, _options?: { type?: 'text' | 'json' }): Promise<string | null> {
    const entry = this.data.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.data.delete(key);
      return null;
    }
    return entry.value;
  }
  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    const expiresAt = options?.expirationTtl
      ? Date.now() + options.expirationTtl * 1000
      : Number.MAX_SAFE_INTEGER;
    this.data.set(key, { value, expiresAt });
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

function createKVStore() {
  return new KVStore({ kv: new MockKVNamespace(), consistencyWarning: false });
}

runStoreConformance({ name: 'KVStore', createStore: createKVStore });
