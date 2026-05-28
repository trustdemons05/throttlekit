import { runStoreConformance } from '../testkit/store-conformance.js';
import { MemoryStore } from '../../src/stores/memory-store.js';

runStoreConformance({
  name: 'MemoryStore',
  createStore: () => new MemoryStore(),
});
