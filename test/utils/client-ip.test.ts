import { describe, it, expect } from 'vitest';
import { clientIp } from '../../src/utils/client-ip.js';

describe('clientIp', () => {
  it('returns x-real-ip when available (no trust proxy)', () => {
    const ip = clientIp({ 'x-real-ip': '10.0.0.1' });
    expect(ip).toBe('10.0.0.1');
  });

  it('returns remote-address when x-real-ip not available (no trust proxy)', () => {
    const ip = clientIp({ 'remote-address': '10.0.0.2' });
    expect(ip).toBe('10.0.0.2');
  });

  it('returns 127.0.0.1 as default when no headers', () => {
    const ip = clientIp({});
    expect(ip).toBe('127.0.0.1');
  });

  it('ignores x-forwarded-for when trustProxy is false (default)', () => {
    const ip = clientIp(
      { 'x-forwarded-for': '192.168.1.1', 'x-real-ip': '10.0.0.1' },
      { trustProxy: false },
    );
    expect(ip).toBe('10.0.0.1');
  });

  it('uses x-forwarded-for when trustProxy is a number', () => {
    const ip = clientIp(
      { 'x-forwarded-for': '192.168.1.1, 10.0.0.1, 203.0.113.5' },
      { trustProxy: 1 },
    );
    // trust 1 hop from right = 203.0.113.5
    expect(ip).toBe('203.0.113.5');
  });

  it('trusts N hops from right in x-forwarded-for', () => {
    const ip = clientIp(
      { 'x-forwarded-for': '192.168.1.1, 10.0.0.1, 203.0.113.5' },
      { trustProxy: 2 },
    );
    expect(ip).toBe('10.0.0.1');
  });

  it('falls back to remote-address when x-forwarded-for is missing', () => {
    const ip = clientIp(
      { 'x-real-ip': '10.0.0.1' },
      { trustProxy: 1 },
    );
    expect(ip).toBe('10.0.0.1');
  });

  it('uses CIDR allowlist — matches trusted proxy', () => {
    const ip = clientIp(
      {
        'x-forwarded-for': '192.168.1.100',
        'x-real-ip': '10.0.0.1',
      },
      { trustProxy: ['10.0.0.0/8'] },
    );
    // remote (10.0.0.1) matches 10.0.0.0/8, so trust xff
    expect(ip).toBe('192.168.1.100');
  });

  it('uses CIDR allowlist — does NOT match trusted proxy', () => {
    const ip = clientIp(
      {
        'x-forwarded-for': '192.168.1.100',
        'x-real-ip': '10.0.0.1',
      },
      { trustProxy: ['172.16.0.0/12'] },
    );
    // remote (10.0.0.1) does NOT match 172.16.0.0/12, so use remote
    expect(ip).toBe('10.0.0.1');
  });

  it('unwraps IPv4-mapped IPv6', () => {
    const ip = clientIp({ 'x-real-ip': '::ffff:1.2.3.4' });
    expect(ip).toBe('1.2.3.4');
  });

  it('aggregates IPv6 to /64 prefix by default', () => {
    const ip = clientIp(
      { 'x-real-ip': '2001:db8:1234:5678:9abc:def0:1234:5678' },
    );
    // Aggregated to /64: keep first 4 hextets, zero out rest
    expect(ip).toBe('2001:db8:1234:5678::');
  });

  it('respects custom ipv6Prefix', () => {
    const ip = clientIp(
      { 'x-real-ip': '2001:db8:1234:5678:9abc:def0:1234:5678' },
      { ipv6Prefix: 32 },
    );
    // Aggregated to /32: keep first 2 hextets
    expect(ip).toBe('2001:db8::');
  });

  it('handles x-forwarded-for as array', () => {
    const ip = clientIp(
      { 'x-forwarded-for': ['192.168.1.1', '10.0.0.1'] },
      { trustProxy: 1 },
    );
    expect(ip).toBe('10.0.0.1');
  });

  it('handles single-hop x-forwarded-for', () => {
    const ip = clientIp(
      { 'x-forwarded-for': '203.0.113.5' },
      { trustProxy: 1 },
    );
    expect(ip).toBe('203.0.113.5');
  });
});
