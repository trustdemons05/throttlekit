import { describe, it, expect } from 'vitest';
import { hmacKeyer, hashKey } from '../../src/utils/hmac-key.js';

describe('hashKey', () => {
  it('returns a deterministic 32-char base64url string', () => {
    const result = hashKey('user:123', 'my-secret');
    expect(result).toHaveLength(32);
    expect(result).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('produces same output for same inputs', () => {
    const a = hashKey('hello', 'secret');
    const b = hashKey('hello', 'secret');
    expect(a).toBe(b);
  });

  it('produces different output for different keys', () => {
    const a = hashKey('user:123', 'secret');
    const b = hashKey('user:456', 'secret');
    expect(a).not.toBe(b);
  });

  it('produces different output for different secrets', () => {
    const a = hashKey('user:123', 'secret-a');
    const b = hashKey('user:123', 'secret-b');
    expect(a).not.toBe(b);
  });

  it('handles empty string key', () => {
    const result = hashKey('', 'secret');
    expect(result).toHaveLength(32);
  });

  it('handles special characters in key', () => {
    const result = hashKey('user:123!@#$%^&*()', 'secret');
    expect(result).toHaveLength(32);
  });
});

describe('hmacKeyer', () => {
  it('returns a function that derives keys', () => {
    const keyer = hmacKeyer('my-secret');
    expect(typeof keyer).toBe('function');
    const result = keyer('user:123');
    expect(result).toHaveLength(32);
  });

  it('matches hashKey one-shot output', () => {
    const keyer = hmacKeyer('test-secret');
    const fromKeyer = keyer('some-key');
    const fromHash = hashKey('some-key', 'test-secret');
    expect(fromKeyer).toBe(fromHash);
  });

  it('throws if secret is empty string', () => {
    expect(() => hmacKeyer('')).toThrow('secret is required');
  });
});
