import type { Clock } from '../core/types.js';

export interface TokenBudgetOptions {
  /** Maximum tokens allowed per window */
  budgetPerWindow: number;
  /** Window duration in milliseconds */
  windowMs: number;
  /** Optional: custom token estimator function */
  estimator?: TokenEstimator;
  /** Optional: clock for deterministic testing */
  clock?: Clock;
}

export interface TokenEstimator {
  /** Estimate token count for a given text/prompt */
  estimate(text: string): number;
}

export interface TokenBudgetResult {
  /** Whether the request is within budget */
  allowed: boolean;
  /** Configured token budget for this window */
  budget: number;
  /** Remaining tokens in current window */
  remaining: number;
  /** Epoch ms when budget resets */
  resetAt: number;
  /** Ms to wait before retrying (0 if allowed) */
  retryAfterMs: number;
  /** Estimated tokens for this request */
  estimatedTokens: number;
}

export interface TokenReconciliation {
  /** Difference between estimated and actual tokens */
  delta: number;
  /** Adjusted remaining after reconciliation */
  remaining: number;
  /** Whether the adjustment caused a retroactive over-budget */
  overBudget: boolean;
}

export interface TokenBudgetLimiter {
  /** Estimate token cost for a prompt */
  estimateCost(text: string): number;
  /** Check if request is within budget, consuming estimated tokens */
  check(key: string, estimatedTokens: number): Promise<TokenBudgetResult>;
  /** Synchronous check */
  checkSync(key: string, estimatedTokens: number): TokenBudgetResult;
  /** Record actual token usage and reconcile with estimate */
  recordActual(key: string, actualTokens: number): Promise<TokenReconciliation>;
  /** Record actual (sync) */
  recordActualSync(key: string, actualTokens: number): TokenReconciliation;
  /** Get current budget state without consuming */
  peek(key: string): Promise<TokenBudgetResult>;
  /** Reset budget for a key */
  reset(key: string): Promise<void>;
}
