import { runStoreConformance } from '../testkit/store-conformance.js';
import { D1Store } from '../../src/stores/cloudflare-d1.js';
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
  D1ExecResult,
} from '../../src/stores/cloudflare-d1.js';

interface StoredRow {
  state: string;
  expires_at: number;
  version: number;
}

class MockD1PreparedStatement implements D1PreparedStatement {
  constructor(
    readonly query: string,
    private readonly store: Map<string, StoredRow>,
    readonly values: unknown[] = [],
  ) {}
  bind(...values: unknown[]): MockD1PreparedStatement {
    return new MockD1PreparedStatement(this.query, this.store, values);
  }
  async first<T>(): Promise<T | null> {
    const sql = this.query.trim();
    if (sql.toUpperCase().startsWith('SELECT')) {
      const key = this.values[0];
      const now = this.values.length > 1 ? this.values[1] : undefined;
      if (key === undefined) return null;
      const entry = this.store.get(String(key));
      if (entry && (now === undefined || entry.expires_at > Number(now))) {
        return { state: entry.state, version: entry.version } as T;
      }
    }
    return null;
  }
  async run(): Promise<D1Result<unknown>> {
    const sql = this.query.trim();
    const upper = sql.toUpperCase();
    if (upper.startsWith('UPDATE')) {
      const newState = this.values[0];
      const newExpiresAt = this.values[1];
      const key = this.values[2];
      const expectedVersion = this.values[3];
      if (key !== undefined && expectedVersion !== undefined && newState !== undefined) {
        const entry = this.store.get(String(key));
        if (entry && entry.version === Number(expectedVersion)) {
          this.store.set(String(key), { state: String(newState), expires_at: Number(newExpiresAt), version: entry.version + 1 });
          return { results: [], success: true, meta: { changes: 1 } };
        }
        return { results: [], success: false, meta: { changes: 0 } };
      }
      return { results: [], success: true, meta: {} };
    }
    if (upper.includes('INSERT') && upper.includes('REPLACE')) {
      const key = this.values[0];
      const state = this.values[1];
      const expiresAt = this.values[2];
      if (key !== undefined && state !== undefined && expiresAt !== undefined) {
        this.store.set(String(key), { state: String(state), expires_at: Number(expiresAt), version: 1 });
      }
      return { results: [], success: true, meta: { changes: 1 } };
    }
    if (upper.startsWith('INSERT') && !upper.includes('REPLACE')) {
      const key = this.values[0];
      const state = this.values[1];
      const expiresAt = this.values[2];
      if (key !== undefined && state !== undefined && expiresAt !== undefined) {
        if (this.store.has(String(key))) {
          throw new Error('UNIQUE constraint failed: key already exists');
        }
        this.store.set(String(key), { state: String(state), expires_at: Number(expiresAt), version: 1 });
      }
      return { results: [], success: true, meta: { changes: 1 } };
    }
    if (upper.startsWith('DELETE')) {
      const key = this.values[0];
      if (key !== undefined) this.store.delete(String(key));
      return { results: [], success: true, meta: { changes: 1 } };
    }
    return { results: [], success: true, meta: {} };
  }
  async all<T>(): Promise<D1Result<T>> {
    return { results: [], success: true, meta: {} };
  }
}

class MockD1Database implements D1Database {
  readonly store = new Map<string, StoredRow>();
  readonly execCalls: string[] = [];
  prepare(query: string): MockD1PreparedStatement {
    return new MockD1PreparedStatement(query, this.store);
  }
  async exec(query: string): Promise<D1ExecResult> {
    this.execCalls.push(query);
    return { count: 0, duration: 0 };
  }
  async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const results: D1Result<T>[] = [];
    for (const stmt of statements) {
      results.push(await stmt.run() as D1Result<T>);
    }
    return results;
  }
}

function createD1Store() {
  return new D1Store({ db: new MockD1Database() });
}

runStoreConformance({ name: 'D1Store', createStore: createD1Store });
