import { isIPv6 as nodeIsIPv6 } from 'node:net';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClientIpOptions {
  /**
   * Trust proxy hops.
   * - `false` (default): use `remoteAddr` only; ignore `x-forwarded-for`
   * - `number`: trust up to N hops from the rightmost IP in `x-forwarded-for`
   * - `string[]`: CIDR allowlist — trust `x-forwarded-for` only if remoteAddr
   *   matches one of the trusted CIDRs
   */
  trustProxy?: false | number | string[];

  /**
   * Number of bits to keep for IPv6 prefix aggregation (default: 64).
   * Set to 128 to disable aggregation.
   */
  ipv6Prefix?: number;
}

// ---------------------------------------------------------------------------
// CIDR helpers
// ---------------------------------------------------------------------------

/**
 * Parse a CIDR string like "192.168.1.0/24" into { base, mask, bits }.
 */
function parseCidr(cidr: string): { base: bigint; mask: bigint; bits: number } | null {
  const idx = cidr.indexOf('/');
  if (idx === -1) return null;
  const addr = cidr.slice(0, idx);
  const prefixLen = Number(cidr.slice(idx + 1));
  if (Number.isNaN(prefixLen) || prefixLen < 0) return null;

  // Normalize address (handles both IPv4 and IPv6)
  const bytes = toBytes(addr);
  if (!bytes) return null;

  const bits = bytes.length * 8;
  if (prefixLen > bits) return null;

  const base = bytesToBigInt(bytes);
  const mask = prefixLen === 0 ? 0n : (1n << BigInt(bits - prefixLen)) - 1n;

  return { base: base & ~mask, mask, bits };
}

/**
 * Convert an IP address string (IPv4 or IPv6) to Uint8Array of raw bytes.
 */
function toBytes(addr: string): Uint8Array | null {
  // Try IPv4
  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1).map(Number);
    if (octets.some((o) => o < 0 || o > 255)) return null;
    return new Uint8Array(octets);
  }

  // Try IPv6 (basic parse)
  if (addr.includes(':')) {
    return parseIpv6Bytes(addr);
  }

  return null;
}

/**
 * Parse an IPv6 string to a 16-byte Uint8Array.
 */
function parseIpv6Bytes(addr: string): Uint8Array | null {
  // Normalise: handle "::ffff:1.2.3.4" (IPv4-mapped IPv6)
  const ipv4Mapped = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(addr);
  if (ipv4Mapped) {
    return toBytes(ipv4Mapped[1]!);
  }

  // Handle full IPv6 with possible IPv4 tail
  let ipv4Tail: string | null = null;
  let cleanAddr = addr;
  const ipv4TailMatch = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(addr);
  if (ipv4TailMatch) {
    ipv4Tail = ipv4TailMatch[1]!;
    cleanAddr = addr.slice(0, ipv4TailMatch.index);
  }

  const parts = cleanAddr.split(':');

  // Expand ::
  const emptyIdx = parts.indexOf('');
  let groups: string[];
  if (emptyIdx !== -1) {
    const left = parts.slice(0, emptyIdx).filter(Boolean);
    const right = parts.slice(emptyIdx + 1).filter(Boolean);
    const missing = 8 - left.length - right.length - (ipv4Tail ? 1 : 0);
    groups = [...left, ...Array(missing).fill('0'), ...right];
  } else {
    groups = parts;
  }

  if (ipv4Tail) {
    groups.push(ipv4Tail);
  }

  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const val = parseInt(groups[i] ?? '0', 16);
    if (Number.isNaN(val)) return null;
    bytes[i * 2] = (val >> 8) & 0xff;
    bytes[i * 2 + 1] = val & 0xff;
  }
  return bytes;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (const b of bytes) {
    result = (result << 8n) | BigInt(b);
  }
  return result;
}

function bigIntToBytes(val: bigint, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--) {
    bytes[i] = Number(val & 0xffn);
    val >>= 8n;
  }
  return bytes;
}

function cidrContains(cidr: string, addr: string): boolean {
  const parsed = parseCidr(cidr);
  if (!parsed) return false;
  const bytes = toBytes(addr);
  if (!bytes) return false;
  const addrInt = bytesToBigInt(bytes);
  // Mask the address and compare
  const masked = addrInt & ~parsed.mask;
  return masked === parsed.base;
}

/**
 * Check if address is IPv4-mapped IPv6 (::ffff:x.x.x.x).
 */
function isIpv4Mapped(addr: string): boolean {
  return /^::ffff:\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr);
}

/**
 * Strip IPv4-mapped IPv6 prefix, returning just the IPv4 address.
 */
function unwrapIpv4Mapped(addr: string): string {
  const match = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(addr);
  return match ? match[1]! : addr;
}

/**
 * Aggregate an IPv6 address to a /N prefix.
 */
function aggregateIpv6(addr: string, prefix: number): string {
  const bytes = parseIpv6Bytes(addr);
  if (!bytes) return addr;
  if (prefix >= 128) return addr;

  const addrInt = bytesToBigInt(bytes);
  const mask = prefix === 0 ? 0n : (1n << BigInt(128 - prefix)) - 1n;
  const masked = addrInt & ~mask;

  // Convert back to IPv6 string
  const maskedBytes = bigIntToBytes(masked, 16);
  const hextets: string[] = [];
  for (let i = 0; i < 8; i++) {
    const val = ((maskedBytes[i * 2] ?? 0) << 8) | (maskedBytes[i * 2 + 1] ?? 0);
    hextets.push(val.toString(16));
  }

  // Use :: compression (simplified: compress longest run of zeros)
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i < 8; i++) {
    if (hextets[i] === '0') {
      if (curStart === -1) curStart = i;
      curLen++;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }

  if (bestLen < 2) {
    return hextets.join(':');
  }

  const before = hextets.slice(0, bestStart).join(':');
  const after = hextets.slice(bestStart + bestLen).join(':');
  return `${before}::${after}`;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Get a single header value as string. If the header is an array, use the
 * first element. Returns undefined if the header is not present.
 */
function getHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const val = headers[name];
  if (val === undefined || val === null) return undefined;
  if (Array.isArray(val)) return val[0];
  return val;
}

/**
 * Get x-forwarded-for header as an array of individual IPs.
 * Handles both string and string[] header values.
 */
function getForwardedFor(
  headers: Record<string, string | string[] | undefined>,
): string[] {
  const xff = headers['x-forwarded-for'];
  if (typeof xff === 'string') {
    return xff.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (Array.isArray(xff)) {
    return xff.flatMap((s) => s.split(',').map((s2) => s2.trim())).filter(Boolean);
  }
  return [];
}

/**
 * Extract the client IP address from a request-like headers object.
 *
 * Features:
 * - Unwraps IPv4-mapped IPv6 (`::ffff:1.2.3.4` → `1.2.3.4`)
 * - Aggregates IPv6 to a configurable prefix (default /64)
 * - Respects `trustProxy` setting for `x-forwarded-for` processing
 */
export function clientIp(
  headers: Record<string, string | string[] | undefined>,
  opts?: ClientIpOptions,
): string {
  const trustProxy = opts?.trustProxy ?? false;
  const ipv6Prefix = opts?.ipv6Prefix ?? 64;

  // Remote address is expected in headers['remote-address'] or headers['x-real-ip']
  const remoteAddr =
    getHeader(headers, 'x-real-ip') ??
    getHeader(headers, 'remote-address') ??
    '127.0.0.1';

  let ip: string;

  if (trustProxy === false) {
    // No proxy trust — ignore x-forwarded-for
    ip = remoteAddr;
  } else if (typeof trustProxy === 'number') {
    // Trust N hops from the rightmost IP in x-forwarded-for
    const ips = getForwardedFor(headers);
    if (ips.length > 0) {
      const idx = Math.max(0, ips.length - trustProxy);
      ip = ips[idx] ?? remoteAddr;
    } else {
      ip = remoteAddr;
    }
  } else {
    // CIDR allowlist: trust x-forwarded-for only if remoteAddr matches a CIDR
    const trustedCidrs = trustProxy as string[];
    const remoteMatches = trustedCidrs.some((cidr) => cidrContains(cidr, remoteAddr));
    if (remoteMatches) {
      const ips = getForwardedFor(headers);
      ip = ips.length > 0 ? (ips[0] ?? remoteAddr) : remoteAddr;
    } else {
      ip = remoteAddr;
    }
  }

  // Unwrap IPv4-mapped IPv6
  if (isIpv4Mapped(ip)) {
    ip = unwrapIpv4Mapped(ip);
  }

  // Aggregate IPv6 to /N prefix
  if (nodeIsIPv6(ip) && ipv6Prefix < 128) {
    ip = aggregateIpv6(ip, ipv6Prefix);
  }

  return ip;
}
