/**
 * Adaptive Concurrency Guard.
 *
 * Implements gradient2-based adaptive concurrency limiting,
 * inspired by TCP congestion control.
 *
 * - acquire(): synchronously acquires a lease
 * - release({ dropped? }): adjusts the concurrency limit based on RTT
 *
 * The limit is dynamically adjusted using the gradient2 algorithm:
 *   gradient = clamp(noloadRtt / measuredRtt, 0.5, 1.0)
 *   newLimit = current * gradient + sqrt(current)
 *   if dropped: newLimit = current * 0.75
 *
 * Maintains a rolling 128-sample RTT window for p50/p99 statistics.
 */

import type { ConcurrencyLease, ConcurrencyGuard } from '../core/types.js';

// ---------------------------------------------------------------------------
// Rolling RTT statistics (128-sample window)
// ---------------------------------------------------------------------------

const WINDOW_SIZE = 128;

class RttWindow {
  private buffer: Float64Array;
  private head = 0;
  private count = 0;
  private _noloadRtt = Infinity;

  constructor() {
    this.buffer = new Float64Array(WINDOW_SIZE);
  }

  /** Add an RTT sample in milliseconds */
  add(rttMs: number): void {
    this.buffer[this.head] = rttMs;
    this.head = (this.head + 1) % WINDOW_SIZE;
    if (this.count < WINDOW_SIZE) {
      this.count++;
    }

    // Track noloadRtt as the minimum observed RTT
    if (rttMs > 0 && rttMs < this._noloadRtt) {
      this._noloadRtt = rttMs;
    }
  }

  /** Compute p50 (median) from the window */
  p50(): number {
    if (this.count === 0) return 0;
    const sorted = this.getSortedSamples();
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
      return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return sorted[mid];
  }

  /** Compute p99 from the window */
  p99(): number {
    if (this.count === 0) return 0;
    const sorted = this.getSortedSamples();
    const idx = Math.ceil(sorted.length * 0.99) - 1;
    return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
  }

  /** The minimum observed RTT (no-load latency estimate) */
  get noloadRtt(): number {
    return this._noloadRtt === Infinity ? 0 : this._noloadRtt;
  }

  /** Reset noloadRtt to allow re-measurement (called when limit resets) */
  resetNoloadRtt(): void {
    this._noloadRtt = Infinity;
  }

  private getSortedSamples(): number[] {
    const samples: number[] = [];
    for (let i = 0; i < this.count; i++) {
      samples.push(this.buffer[i]);
    }
    return samples.sort((a, b) => a - b);
  }
}

// ---------------------------------------------------------------------------
// Adaptive Concurrency Guard
// ---------------------------------------------------------------------------

export interface AdaptiveConcurrencyOptions {
  /** Minimum concurrency limit (default: 4) */
  minLimit?: number;
  /** Maximum concurrency limit (default: 512) */
  maxLimit?: number;
  /** Algorithm to use (default: 'gradient2') */
  algorithm?: 'gradient2';
}

interface InternalLeaseState {
  startTime: number;
  guard: AdaptiveConcurrencyImpl;
}

class AdaptiveConcurrencyImpl implements ConcurrencyGuard {
  private _currentLimit: number;
  private _inflight = 0;
  private readonly _minLimit: number;
  private readonly _maxLimit: number;
  private readonly _rttWindow: RttWindow;

  constructor(options: AdaptiveConcurrencyOptions) {
    this._minLimit = options.minLimit ?? 4;
    this._maxLimit = options.maxLimit ?? 512;
    this._currentLimit = this._maxLimit;
    this._rttWindow = new RttWindow();
  }

  get limit(): number {
    return this._currentLimit;
  }

  get inflight(): number {
    return this._inflight;
  }

  /**
   * Acquire a concurrency lease (synchronous).
   * Returns a lease with ok=false if at max capacity.
   */
  acquire(): ConcurrencyLease {
    if (this._inflight >= this._maxLimit) {
      // At hard limit — return a no-op lease
      return {
        ok: false,
        inflight: this._inflight,
        limit: this._currentLimit,
        release: () => {
          // No-op: never acquired
        },
      };
    }

    this._inflight++;
    const startTime = performance.now();

    const lease: InternalLeaseState = { startTime, guard: this };

    return {
      ok: true,
      inflight: this._inflight,
      limit: this._currentLimit,
      release: (opts?: { dropped?: boolean }) => {
        this.handleRelease(lease, opts?.dropped ?? false);
      },
    };
  }

  /**
   * Get current statistics.
   */
  stats(): { p50Rtt: number; p99Rtt: number; noloadRtt: number } {
    return {
      p50Rtt: this._rttWindow.p50(),
      p99Rtt: this._rttWindow.p99(),
      noloadRtt: this._rttWindow.noloadRtt,
    };
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private handleRelease(lease: InternalLeaseState, dropped: boolean): void {
    this._inflight = Math.max(0, this._inflight - 1);

    const measuredRtt = performance.now() - lease.startTime;
    this._rttWindow.add(measuredRtt);

    if (dropped) {
      // Multiplicative decrease on dropped requests
      this._currentLimit = Math.max(
        this._minLimit,
        Math.floor(this._currentLimit * 0.75),
      );
      return;
    }

    // Gradient2 algorithm
    const noloadRtt = this._rttWindow.noloadRtt;
    let gradient = 1.0;

    if (noloadRtt > 0 && measuredRtt > 0) {
      gradient = Math.max(0.5, Math.min(1.0, noloadRtt / measuredRtt));
    }

    const newLimit = this._currentLimit * gradient + Math.sqrt(this._currentLimit);

    this._currentLimit = Math.max(
      this._minLimit,
      Math.min(this._maxLimit, Math.round(newLimit)),
    );
  }
}

/**
 * Create an adaptive concurrency guard.
 *
 * @param options.minLimit   - Minimum concurrency limit (default: 4)
 * @param options.maxLimit   - Maximum concurrency limit (default: 512)
 * @param options.algorithm  - Algorithm to use (default: 'gradient2')
 */
export function createAdaptiveConcurrency(options: AdaptiveConcurrencyOptions = {}): ConcurrencyGuard {
  return new AdaptiveConcurrencyImpl(options);
}
