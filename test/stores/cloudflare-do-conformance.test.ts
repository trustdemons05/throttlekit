import { runStoreConformance } from '../testkit/store-conformance.js';
import {
  DurableObjectStore,
  ThrottleKitDO,
} from '../../src/stores/cloudflare-do.js';
import type {
  DurableObjectNamespace,
  DurableObjectId,
  DurableObjectStoreOptions,
  DurableObjectStub,
  DurableObjectState,
  DurableObjectStorage,
} from '../../src/stores/cloudflare-do.js';

class MockDurableObjectStorage implements DurableObjectStorage {
  private data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, value);
  }
  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }
  async setAlarm(_scheduledTime: number): Promise<void> {}
}

class MockDurableObjectState implements DurableObjectState {
  storage: DurableObjectStorage;
  constructor() {
    this.storage = new MockDurableObjectStorage();
  }
}

class MockDurableObjectStub implements DurableObjectStub {
  private doInstance: ThrottleKitDO;
  private lock: Promise<void> = Promise.resolve();
  constructor(state: DurableObjectState) {
    this.doInstance = new ThrottleKitDO(state);
  }
  async fetch(request: Request): Promise<Response> {
    const prev = this.lock;
    let release: () => void;
    this.lock = new Promise<void>((resolve) => { release = resolve; });
    await prev;
    try {
      return await this.doInstance.fetch(request);
    } finally {
      release!();
    }
  }
}

class MockDurableObjectNamespace implements DurableObjectNamespace {
  private stubs = new Map<string, MockDurableObjectStub>();
  private doStates = new Map<string, DurableObjectState>();
  idFromName(name: string): DurableObjectId {
    return { toString: () => name };
  }
  get(id: DurableObjectId): DurableObjectStub {
    const key = id.toString();
    let stub = this.stubs.get(key);
    if (!stub) {
      const state = new MockDurableObjectState();
      this.doStates.set(key, state);
      stub = new MockDurableObjectStub(state);
      this.stubs.set(key, stub);
    }
    return stub;
  }
}

function createDOStore() {
  return new DurableObjectStore({ namespace: new MockDurableObjectNamespace() });
}

runStoreConformance({ name: 'DurableObjectStore', createStore: createDOStore });
