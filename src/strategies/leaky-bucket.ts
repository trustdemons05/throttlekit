/**
 * Leaky Bucket shaper strategy.
 *
 * Implements the Shaper interface for traffic shaping:
 * - schedule(key, cost?): Promise<void> — resolves after delay or throws QueueFullError
 * - reserve(key, cost?): Promise<ShaperResult>
 * - reserveSync(key, cost?): ShaperResult
 *
 * State: Float64Array([next_send_time]) per key.
 *
 * Algorithm:
 *   delay = max(0, next_send_time - now)
 *   next_send_time = max(now, next_send_time) + (cost / ratePerSec * 1000)
 *   Throw QueueFullError if delay > maxQueueMs
 */

import type { Clock, Shaper, ShaperResult } from '../core/types.js';
import { QueueFullError } from '../core/types.js';

export { QueueFullError };

// ---------------------------------------------------------------------------
// Shaper factory
// ---------------------------------------------------------------------------

export interface LeakyBucketOptions {
  /** Drain rate in requests per second */
  ratePerSec: number;
  /** Maximum queue delay in milliseconds before rejecting */
  maxQueueMs: number;
  /** Clock implementation (injected for deterministic testing) */
  clock: Clock;
}

/**
 * Create a Leaky Bucket shaper instance.
 *
 * @param options.ratePerSec - Drain rate in requests per second
 * @param options.maxQueueMs - Maximum queue delay before rejecting
 * @param options.clock      - Clock implementation (injected)
 */
export function createLeakyBucket(options: LeakyBucketOptions): Shaper {
  const { ratePerSec, maxQueueMs, clock } = options;
  const stateMap = new Map<string, Float64Array>();

  /**
   * Reserve capacity: compute delay and advance next_send_time.
   * Returns ShaperResult without advancing the state if the queue is full.
   */
  function doReserve(key: string, cost: number): { result: ShaperResult; state: Float64Array | null } {
    const now = clock.now();
    const state = stateMap.get(key) ?? null;
    const nextSendTime = state?.[0] ?? now;

    const costFactor = cost / ratePerSec * 1000;
    const delay = Math.max(0, nextSendTime - now);

    if (delay > maxQueueMs) {
      return {
        result: {
          accepted: false,
          delayMs: delay,
          retryAfterMs: delay,
          queueDepth: Math.ceil(delay / (1 / ratePerSec * 1000)),
        },
        state: null, // Don't update state
      };
    }

    const newNextSendTime = Math.max(now, nextSendTime) + costFactor;
    const newState = new Float64Array([newNextSendTime]);

    return {
      result: {
        accepted: true,
        delayMs: delay,
        retryAfterMs: delay,
        queueDepth: Math.ceil(newNextSendTime > now ? (newNextSendTime - now) / (1 / ratePerSec * 1000) : 0),
      },
      state: newState,
    };
  }

  return {
    /**
     * Schedule a request. Resolves after the delay, or throws QueueFullError.
     */
    async schedule(key: string, cost: number = 1): Promise<void> {
      const { result, state } = doReserve(key, cost);

      if (!result.accepted) {
        throw new QueueFullError('Queue is full', result.retryAfterMs);
      }

      if (state) {
        stateMap.set(key, state);
      }

      if (result.delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, result.delayMs));
      }
    },

    /**
     * Reserve capacity (async). Never blocks — always returns immediately.
     */
    async reserve(key: string, cost: number = 1): Promise<ShaperResult> {
      const { result, state } = doReserve(key, cost);

      if (result.accepted && state) {
        stateMap.set(key, state);
      }

      return result;
    },

    /**
     * Reserve capacity synchronously. Returns immediately.
     */
    reserveSync(key: string, cost: number = 1): ShaperResult {
      const { result, state } = doReserve(key, cost);

      if (result.accepted && state) {
        stateMap.set(key, state);
      }

      return result;
    },

    /**
     * Reset the shaper state for a given key.
     */
    reset(key: string): Promise<void> {
      stateMap.delete(key);
      return Promise.resolve();
    },
  };
}
