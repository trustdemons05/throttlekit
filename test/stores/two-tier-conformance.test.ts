import { runStoreConformance } from '../testkit/store-conformance.js';
import { createTwoTierStore } from '../../src/stores/two-tier.js';
import { MemoryStore } from '../../src/stores/memory-store.js';

function createTwoTier() {
  return createTwoTierStore({ l2: new MemoryStore(), mode: 'strict' });
}

runStoreConformance({ name: 'TwoTierStore', createStore: createTwoTier });
