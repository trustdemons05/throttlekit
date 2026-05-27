import type { TokenEstimator } from './types.js';

/**
 * Default estimator: ~4 characters per token (GPT-3.5/4 average).
 * Good enough for pre-flight budgeting. Use tiktoken for exact counts.
 */
export const defaultEstimator: TokenEstimator = {
  estimate(text: string): number {
    return Math.ceil(text.length / 4);
  },
};

/**
 * Character-based estimator with configurable ratio.
 */
export function charEstimator(charsPerToken: number = 4): TokenEstimator {
  return {
    estimate(text: string): number {
      return Math.ceil(text.length / charsPerToken);
    },
  };
}

/**
 * Word-based estimator: ~0.75 tokens per word (English average).
 */
export function wordEstimator(tokensPerWord: number = 0.75): TokenEstimator {
  return {
    estimate(text: string): number {
      const words = text.split(/\s+/).filter(w => w.length > 0).length;
      return Math.ceil(words * tokensPerWord);
    },
  };
}

/**
 * JSON-aware estimator: estimates tokens for structured prompts.
 * JSON formatting tokens (braces, brackets, colons) add overhead.
 */
export function jsonEstimator(): TokenEstimator {
  return {
    estimate(text: string): number {
      // JSON has ~15% formatting overhead
      const baseTokens = Math.ceil(text.length / 4);
      try {
        JSON.parse(text);
        return Math.ceil(baseTokens * 1.15);
      } catch {
        return baseTokens;
      }
    },
  };
}
