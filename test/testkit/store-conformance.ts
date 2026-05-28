import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  runStoreConformance as runPublicStoreConformance,
  type StoreConformanceOptions,
} from '../../src/testkit/index.js';
import type { Store } from '../../src/core/types.js';

const vitestApi = { describe, it, expect, beforeEach, afterEach };

export type ConformanceOptions = StoreConformanceOptions;

export function runStoreConformance(options: StoreConformanceOptions): void;
export function runStoreConformance(store: Store, label?: string): void;
export function runStoreConformance(
  optionsOrStore: StoreConformanceOptions | Store,
  label?: string,
): void {
  if ('createStore' in optionsOrStore) {
    runPublicStoreConformance(optionsOrStore, vitestApi);
    return;
  }

  runPublicStoreConformance(optionsOrStore, label, vitestApi);
}
