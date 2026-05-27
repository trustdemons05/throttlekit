import { SystemClock } from '../core/clock.js';
import type { Clock } from '../core/types.js';
import { defaultEstimator } from './estimators.js';
import type {
  TokenBudgetLimiter,
  TokenBudgetOptions,
  TokenBudgetResult,
  TokenReconciliation,
} from './types.js';

// ---------------------------------------------------------------------------
// Internal per-key state
// ---------------------------------------------------------------------------

interface BudgetState {
  /** Tokens consumed in the current window */
  used: number;
  /** Tokens estimated for the most recent check (pending reconciliation) */
  estimated: number;
  /** Epoch ms when the current window started */
  windowStart: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a token-budget limiter that tracks token usage per key within a
 * sliding window.  Supports both async and sync APIs, optional custom
 * estimators, and deterministic testing via injected clock.
 */
export function tokenBudgetLimiter(options: TokenBudgetOptions): TokenBudgetLimiter {
  const {
    budgetPerWindow,
    windowMs,
    estimator = defaultEstimator,
    clock = new SystemClock(),
  } = options;

  const stateMap = new Map<string, BudgetState>();

  // ---- Internal helpers ---------------------------------------------------

  /** Returns existing state for `key` or creates a fresh one (rotating the
   *  window if necessary). */
  function getOrCreateState(key: string, now: number): BudgetState {
    const existing = stateMap.get(key);

    if (existing === undefined || now >= existing.windowStart + windowMs) {
      const fresh: BudgetState = { used: 0, estimated: 0, windowStart: now };
      stateMap.set(key, fresh);
      return fresh;
    }

    return existing;
  }

  /** Core synchronous check logic (used by both check() and checkSync()). */
  function doCheck(key: string, estimatedTokens: number): TokenBudgetResult {
    const now = clock.now();
    const state = getOrCreateState(key, now);

    if (state.used + estimatedTokens > budgetPerWindow) {
      const resetAt = state.windowStart + windowMs;
      const remaining = Math.max(0, budgetPerWindow - state.used);
      return {
        allowed: false,
        budget: budgetPerWindow,
        remaining,
        resetAt,
        retryAfterMs: Math.max(0, resetAt - now),
        estimatedTokens,
      };
    }

    state.used += estimatedTokens;
    state.estimated = estimatedTokens;

    const resetAt = state.windowStart + windowMs;
    const remaining = Math.max(0, budgetPerWindow - state.used);
    return {
      allowed: true,
      budget: budgetPerWindow,
      remaining,
      resetAt,
      retryAfterMs: 0,
      estimatedTokens,
    };
  }

  /** Core synchronous reconciliation logic. */
  function doRecordActual(key: string, actualTokens: number): TokenReconciliation {
    const now = clock.now();
    const state = stateMap.get(key);

    if (state === undefined || now >= state.windowStart + windowMs) {
      throw new Error('No pending estimate for key. Call check() first.');
    }

    const estimatedTokens = state.estimated;
    const delta = actualTokens - estimatedTokens;

    state.used = state.used - estimatedTokens + actualTokens;
    state.estimated = 0;

    const remaining = Math.max(0, budgetPerWindow - state.used);
    const overBudget = state.used > budgetPerWindow;

    return { delta, remaining, overBudget };
  }

  /** Core synchronous peek logic. */
  function doPeek(key: string): TokenBudgetResult {
    const now = clock.now();
    const state = stateMap.get(key);

    // No state or window rotated → budget is fully available
    if (state === undefined || now >= state.windowStart + windowMs) {
      return {
        allowed: true,
        budget: budgetPerWindow,
        remaining: budgetPerWindow,
        resetAt: now + windowMs,
        retryAfterMs: 0,
        estimatedTokens: 0,
      };
    }

    const resetAt = state.windowStart + windowMs;
    const remaining = Math.max(0, budgetPerWindow - state.used);
    const allowed = state.used < budgetPerWindow;

    return {
      allowed,
      budget: budgetPerWindow,
      remaining,
      resetAt,
      retryAfterMs: allowed ? 0 : Math.max(0, resetAt - now),
      estimatedTokens: 0,
    };
  }

  // ---- Public API ---------------------------------------------------------

  return {
    estimateCost(text: string): number {
      return estimator.estimate(text);
    },

    async check(key: string, estimatedTokens: number): Promise<TokenBudgetResult> {
      return doCheck(key, estimatedTokens);
    },

    checkSync(key: string, estimatedTokens: number): TokenBudgetResult {
      return doCheck(key, estimatedTokens);
    },

    async recordActual(key: string, actualTokens: number): Promise<TokenReconciliation> {
      return doRecordActual(key, actualTokens);
    },

    recordActualSync(key: string, actualTokens: number): TokenReconciliation {
      return doRecordActual(key, actualTokens);
    },

    async peek(key: string): Promise<TokenBudgetResult> {
      return doPeek(key);
    },

    async reset(key: string): Promise<void> {
      stateMap.delete(key);
    },
  };
}
