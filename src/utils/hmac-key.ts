import { createHmac } from 'node:crypto';

/**
 * Create a keyer function that derives rate-limit keys using HMAC-SHA256.
 *
 * The returned function takes a `rawKey` string and returns a deterministic,
 * 32-character base64url-encoded HMAC digest.
 *
 * @param secret - HMAC secret key (required)
 * @returns A function: (rawKey: string) => string
 *
 * @example
 * ```typescript
 * const keyer = hmacKeyer('my-secret');
 * const key = keyer('user:123');
 * // => "abc123..." (32 chars, base64url)
 * ```
 */
export function hmacKeyer(secret: string): (rawKey: string) => string {
  if (!secret) {
    throw new Error('hmacKeyer: secret is required');
  }

  return (rawKey: string): string => {
    return hashKey(rawKey, secret);
  };
}

/**
 * One-shot HMAC-SHA256 key derivation.
 *
 * @param rawKey - The raw key to hash
 * @param secret - HMAC secret key
 * @returns 32-character base64url-encoded string
 *
 * @example
 * ```typescript
 * const key = hashKey('user:123', 'my-secret');
 * // => "abc123..." (32 chars, base64url)
 * ```
 */
export function hashKey(rawKey: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(rawKey)
    .digest('base64url')
    .slice(0, 32);
}
