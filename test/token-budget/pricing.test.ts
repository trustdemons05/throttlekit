import { describe, it, expect } from 'vitest';
import { costInDollars, dollarBudget, MODEL_PRICING } from '../../src/token-budget/pricing.js';

describe('costInDollars', () => {
  it('calculates cost for input tokens only (gpt-4o)', () => {
    // 1M input tokens × $2.50/1M = $2.50
    expect(costInDollars('gpt-4o', 1_000_000, 0)).toBe(2.50);
  });

  it('calculates cost for output tokens only (gpt-4o)', () => {
    // 1M output tokens × $10.00/1M = $10.00
    expect(costInDollars('gpt-4o', 0, 1_000_000)).toBe(10.00);
  });

  it('calculates combined input+output cost (gpt-4o)', () => {
    // 500K input × $2.50/1M = $1.25
    // 500K output × $10.00/1M = $5.00
    // Total = $6.25
    expect(costInDollars('gpt-4o', 500_000, 500_000)).toBe(6.25);
  });

  it('throws error for unknown model', () => {
    expect(() => costInDollars('nonexistent-model', 100, 0)).toThrow(
      /Unknown model: nonexistent-model/,
    );
  });

  it('defaults outputTokens to 0', () => {
    expect(costInDollars('gpt-4o-mini', 1_000_000)).toBe(0.15);
  });

  it('calculates cost for gpt-4o-mini correctly', () => {
    expect(costInDollars('gpt-4o-mini', 1_000_000, 500_000)).toBe(0.15 + 0.30);
  });
});

describe('dollarBudget', () => {
  it('returns correct token budget for cheap model (gpt-4o-mini)', () => {
    // blendedPer1M = 0.15 + 1.5*0.60 = 1.05
    // tokensForBudget = floor((1.00 / 1.05) * 1_000_000) = floor(952,380.95) = 952,380
    const result = dollarBudget('gpt-4o-mini', 1.00);
    expect(result.model).toBe('gpt-4o-mini');
    expect(result.budgetPerWindow).toBe(952_380);
  });

  it('returns lower token count for expensive model (gpt-4o)', () => {
    // blendedPer1M = 2.50 + 1.5*10.00 = 17.50
    // tokensForBudget = floor((10.00 / 17.50) * 1_000_000) = floor(571,428.57) = 571,428
    const result = dollarBudget('gpt-4o', 10.00);
    expect(result.model).toBe('gpt-4o');
    expect(result.budgetPerWindow).toBe(571_428);
  });

  it('throws error for unknown model', () => {
    expect(() => dollarBudget('unknown-model', 1.00)).toThrow(
      /Unknown model: unknown-model/,
    );
  });

  it('accepts custom outputRatio', () => {
    // blendedPer1M = 2.50 + 0.5*10.00 = 7.50
    // tokensForBudget = floor((5.00 / 7.50) * 1_000_000) = floor(666,666.66) = 666,666
    const result = dollarBudget('gpt-4o', 5.00, 0.5);
    expect(result.budgetPerWindow).toBe(666_666);
  });
});

describe('MODEL_PRICING', () => {
  it('has at least 8 models', () => {
    expect(Object.keys(MODEL_PRICING).length).toBeGreaterThanOrEqual(8);
  });

  it('all pricing values are positive numbers', () => {
    for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
      expect(pricing.model).toBe(key);
      expect(pricing.inputPer1M).toBeGreaterThan(0);
      expect(pricing.outputPer1M).toBeGreaterThan(0);
    }
  });

  it('output costs are higher than input costs for all models', () => {
    for (const pricing of Object.values(MODEL_PRICING)) {
      expect(pricing.outputPer1M).toBeGreaterThan(pricing.inputPer1M);
    }
  });
});
