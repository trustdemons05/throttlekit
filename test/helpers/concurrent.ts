/**
 * Run N async operations in parallel using Promise.all.
 * Used for MemoryStore + limiter integration concurrency tests.
 */
export async function runConcurrent<T>(
  factory: () => Promise<T>,
  count: number
): Promise<T[]> {
  return Promise.all(Array.from({ length: count }, () => factory()));
}

/**
 * Synchronous variant for ManualClock-based strategy-level tests.
 * CRITICAL: All calls see the EXACT SAME "now" value because
 * the clock doesn't advance between iterations.
 */
export function simulateConcurrentSync<T>(fn: () => T, count: number): T[] {
  return Array.from({ length: count }, () => fn());
}
