/**
 * Count-Min Sketch implementation with conservative update.
 *
 * Uses the Kirsch-Mitzenmacher trick to derive `depth` hash values
 * from two independent hash functions (FNV-1a 32-bit and djb2 32-bit).
 *
 * Memory: width × depth × 4 bytes (≈ 7.6 KB at defaults).
 */

// ---------------------------------------------------------------------------
// Hash functions
// ---------------------------------------------------------------------------

/**
 * FNV-1a 32-bit hash.
 * Returns an unsigned 32-bit integer.
 */
function fnv1a32(str: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  return hash >>> 0;
}

/**
 * djb2 32-bit hash.
 * Returns an unsigned 32-bit integer.
 */
function djb2(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    // hash * 33 + charCode
    hash = (Math.imul(hash, 33) + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

// ---------------------------------------------------------------------------
// Count-Min Sketch
// ---------------------------------------------------------------------------

export class CountMinSketch {
  readonly width: number;
  readonly depth: number;
  private readonly counters: Uint32Array;

  /**
   * @param width   Number of columns per row
   * @param depth   Number of rows (hash functions)
   * @param counters Optional pre-existing counter array (copied)
   */
  constructor(width: number, depth: number, counters?: Uint32Array) {
    this.width = width;
    this.depth = depth;
    if (counters !== undefined) {
      if (counters.length !== width * depth) {
        throw new Error(
          `Invalid counter array length: expected ${width * depth}, got ${counters.length}`,
        );
      }
      this.counters = new Uint32Array(counters);
    } else {
      this.counters = new Uint32Array(width * depth);
    }
  }

  /**
   * Kirsch-Mitzenmacher: h_i(x) = (h1 + i * h2) % 2^32 → % width
   * Returns the flat index into the counters array for row `row`.
   */
  private index(row: number, h1: number, h2: number): number {
    // Math.imul gives 32-bit signed multiply; adding h1 and >>>0 gives unsigned 32-bit
    const col = (Math.imul(h2, row) + h1) >>> 0;
    return row * this.width + (col % this.width);
  }

  /**
   * Increment count for `key` using conservative update.
   * Only increments counters whose current value equals the minimum estimate,
   * reducing false positives from hash collisions.
   *
   * @param key   The identifier to count
   * @param count Amount to add (default 1)
   */
  increment(key: string, count: number = 1): void {
    const h1 = fnv1a32(key);
    const h2 = djb2(key);

    // First pass: find current minimum estimate
    let minVal = Infinity;
    for (let i = 0; i < this.depth; i++) {
      const val = this.counters[this.index(i, h1, h2)]!;
      if (val < minVal) {
        minVal = val;
        if (minVal === 0) break; // Cannot go lower
      }
    }

    // Second pass: only increment counters at the minimum
    for (let i = 0; i < this.depth; i++) {
      const idx = this.index(i, h1, h2);
      if (this.counters[idx] === minVal) {
        this.counters[idx] += count;
      }
    }
  }

  /**
   * Estimate the count for `key`.
   * Returns the minimum value across all rows (the tightest upper bound).
   *
   * Must be allocation-free on the hot path.
   */
  estimate(key: string): number {
    const h1 = fnv1a32(key);
    const h2 = djb2(key);
    let min = Infinity;

    for (let i = 0; i < this.depth; i++) {
      const val = this.counters[this.index(i, h1, h2)]!;
      if (val < min) {
        min = val;
        if (min === 0) break; // Early exit: cannot get lower
      }
    }

    return min;
  }

  /**
   * Zero all counters.
   */
  reset(): void {
    this.counters.fill(0);
  }

  /**
   * Element-wise addition of another sketch into this one.
   * Both sketches must have identical dimensions.
   */
  merge(other: CountMinSketch): void {
    if (other.width !== this.width || other.depth !== this.depth) {
      throw new Error(
        `Sketch dimensions mismatch: ` +
        `(${other.width},${other.depth}) vs (${this.width},${this.depth})`,
      );
    }
    for (let i = 0; i < this.counters.length; i++) {
      this.counters[i] = (this.counters[i] ?? 0) + (other.counters[i] ?? 0);
    }
  }

  /**
   * Return a copy of the internal counter array.
   */
  snapshot(): Uint32Array {
    return this.counters.slice();
  }

  /**
   * Compact serialization: returns a Uint8Array view of the counter data.
   * Length = counters.length * 4 bytes.
   */
  toBytes(): Uint8Array {
    const bytes = new Uint8Array(this.counters.length * 4);
    const view = new Uint32Array(bytes.buffer, 0, this.counters.length);
    view.set(this.counters);
    return bytes;
  }
}
