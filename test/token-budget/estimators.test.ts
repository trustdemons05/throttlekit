import { describe, it, expect } from 'vitest';
import {
  defaultEstimator,
  charEstimator,
  wordEstimator,
  jsonEstimator,
} from '../../src/token-budget/estimators.js';

describe('defaultEstimator', () => {
  it('estimates tokens as ceil(length / 4)', () => {
    // "hello world" = 11 chars → ceil(11/4) = 3
    expect(defaultEstimator.estimate('hello world')).toBe(3);
  });

  it('returns 0 for empty string', () => {
    expect(defaultEstimator.estimate('')).toBe(0);
  });
});

describe('charEstimator', () => {
  it('uses custom chars-per-token ratio', () => {
    // "hello" = 5 chars, ratio 3 → ceil(5/3) = 2
    expect(charEstimator(3).estimate('hello')).toBe(2);
  });

  it('defaults to 4 chars per token', () => {
    expect(charEstimator().estimate('hello world')).toBe(3);
  });

  it('returns 0 for empty string', () => {
    expect(charEstimator(3).estimate('')).toBe(0);
  });
});

describe('wordEstimator', () => {
  it('estimates tokens as ceil(words * tokensPerWord)', () => {
    // "hello world foo bar" = 4 words, 0.75 → ceil(4 * 0.75) = 3
    expect(wordEstimator(0.75).estimate('hello world foo bar')).toBe(3);
  });

  it('defaults to 0.75 tokens per word', () => {
    expect(wordEstimator().estimate('one two three')).toBe(3); // ceil(3 * 0.75) = 3
  });

  it('returns 0 for empty string', () => {
    expect(wordEstimator().estimate('')).toBe(0);
  });

  it('handles multiple spaces between words', () => {
    expect(wordEstimator(1).estimate('hello    world')).toBe(2);
  });
});

describe('jsonEstimator', () => {
  it('adds ~15% overhead for valid JSON', () => {
    const json = '{"key": "value"}';
    // base = ceil(15/4) = 4, * 1.15 = 4.6 → ceil(4.6) = 5
    expect(jsonEstimator().estimate(json)).toBe(5);
  });

  it('uses base estimate for non-JSON strings', () => {
    // "hello world" is not valid JSON → base = ceil(11/4) = 3
    expect(jsonEstimator().estimate('hello world')).toBe(3);
  });

  it('returns 0 for empty string', () => {
    expect(jsonEstimator().estimate('')).toBe(0);
  });
});
