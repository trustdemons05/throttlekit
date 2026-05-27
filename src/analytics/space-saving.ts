/**
 * Space-Saving algorithm (Metwally et al. 2005) for tracking
 * top-K most frequent items in a stream with bounded memory.
 *
 * Maintains at most `k` (item, count, error) triples.
 * When an item is observed:
 *   - If it is already monitored: increment its count
 *   - If fewer than k items are monitored: add with count=1, error=0
 *   - Otherwise: replace the item with minimum count (new.error = old.count, new.count = old.count + 1)
 *
 * @template T - The item type
 */

export class SpaceSaving<T> {
  private readonly k: number;
  private readonly map: Map<T, { count: number; error: number }>;
  constructor(k: number) {
    if (k < 1) {
      throw new Error('SpaceSaving: k must be at least 1');
    }
    this.k = k;
    this.map = new Map<T, { count: number; error: number }>();
    }

  /**
   * Observe an item in the stream.
   * Implements the Space-Saving algorithm.
   */
  observe(item: T): void {
    const entry = this.map.get(item);
    if (entry !== undefined) {
      // Already monitored: increment count
      entry.count++;
    } else if (this.map.size < this.k) {
      // Fewer than k items: add with count=1, error=0
      this.map.set(item, { count: 1, error: 0 });
    } else {
      // At capacity: find the item with minimum count
      let minItem: T | undefined;
      let minCount: number | undefined;

      for (const [key, value] of this.map) {
        if (minItem === undefined || value.count < minCount!) {
          minItem = key;
          minCount = value.count;
        }
      }

      // Replace the minimum-count item
      if (minItem !== undefined && minCount !== undefined) {
        this.map.delete(minItem);
        this.map.set(item, {
          count: minCount + 1,
          error: minCount,
        });
      }
    }
  }

  /**
   * Return the current top-K items sorted by count descending.
   * Each item has: item, count (estimated frequency), error (maximum over-count).
   *
   * @returns Array of { item, count, error } sorted by count descending
   */
  topK(): Array<{ item: T; count: number; error: number }> {
    const entries = Array.from(this.map.entries())
      .map(([item, { count, error }]) => ({ item, count, error }));

    // Sort by count descending, then by item for determinism
    entries.sort((a, b) => {
      const cmp = b.count - a.count;
      if (cmp !== 0) return cmp;
      // Tie-break: use string representation for determinism
      const aStr = String(a.item);
      const bStr = String(b.item);
      return aStr < bStr ? -1 : aStr > bStr ? 1 : 0;
    });

    return entries;
  }

  /**
   * Clear all tracked items.
   */
  reset(): void {
    this.map.clear();
  }
}