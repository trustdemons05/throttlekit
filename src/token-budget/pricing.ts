export interface ModelPricing {
  /** Model identifier */
  model: string;
  /** Input cost per 1M tokens in USD */
  inputPer1M: number;
  /** Output cost per 1M tokens in USD */
  outputPer1M: number;
}

/**
 * Pricing table for popular LLM models (as of May 2026).
 * These are approximations — check provider docs for current pricing.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  'gpt-4o': { model: 'gpt-4o', inputPer1M: 2.50, outputPer1M: 10.00 },
  'gpt-4o-mini': { model: 'gpt-4o-mini', inputPer1M: 0.15, outputPer1M: 0.60 },
  'gpt-4-turbo': { model: 'gpt-4-turbo', inputPer1M: 10.00, outputPer1M: 30.00 },
  'gpt-3.5-turbo': { model: 'gpt-3.5-turbo', inputPer1M: 0.50, outputPer1M: 1.50 },
  'claude-sonnet-4': { model: 'claude-sonnet-4', inputPer1M: 3.00, outputPer1M: 15.00 },
  'claude-haiku': { model: 'claude-haiku', inputPer1M: 0.25, outputPer1M: 1.25 },
  'gemini-2.5-pro': { model: 'gemini-2.5-pro', inputPer1M: 1.25, outputPer1M: 10.00 },
  'gemini-2.5-flash': { model: 'gemini-2.5-flash', inputPer1M: 0.15, outputPer1M: 0.60 },
  'deepseek-v3': { model: 'deepseek-v3', inputPer1M: 0.27, outputPer1M: 1.10 },
  'deepseek-r1': { model: 'deepseek-r1', inputPer1M: 0.55, outputPer1M: 2.19 },
};

/**
 * Calculate cost in USD for a given number of tokens.
 *
 * @param model - Model identifier (key in MODEL_PRICING)
 * @param inputTokens - Number of input tokens
 * @param outputTokens - Number of output tokens
 * @returns Cost in USD
 */
export function costInDollars(
  model: string,
  inputTokens: number,
  outputTokens: number = 0,
): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) {
    throw new Error(`Unknown model: ${model}. Available: ${Object.keys(MODEL_PRICING).join(', ')}`);
  }
  return (inputTokens / 1_000_000) * pricing.inputPer1M
    + (outputTokens / 1_000_000) * pricing.outputPer1M;
}

/**
 * Create a dollar-budget limiter: converts a USD budget to a token budget.
 *
 * @param model - Model identifier
 * @param dollarBudgetPerWindow - Maximum USD spend per window
 * @param outputRatio - Expected output/input token ratio (default 1.5)
 */
export function dollarBudget(
  model: string,
  dollarBudgetPerWindow: number,
  outputRatio: number = 1.5,
): { budgetPerWindow: number; model: string } {
  const pricing = MODEL_PRICING[model];
  if (!pricing) throw new Error(`Unknown model: ${model}`);
  // Weighted cost per token: input weight 1, output weight outputRatio
  const blendedPer1M = pricing.inputPer1M + outputRatio * pricing.outputPer1M;
  const tokensForBudget = Math.floor((dollarBudgetPerWindow / blendedPer1M) * 1_000_000);
  return { budgetPerWindow: tokensForBudget, model };
}
