import { describe, it, expect } from 'vitest';
import { DashboardRegistry } from '../../src/dashboard/registry.js';

function createMockSource(name: string) {
  let count = 0;
  return {
    name,
    analytics() {
      count++;
      return {
        allowed: 100 + count,
        denied: 10 + count,
        total: 110 + count * 2,
        denyRate: (10 + count) / (110 + count * 2),
        topRequested: [{ key: '/api/test', count: 50, error: 0 }],
        topDenied: [{ key: '/api/admin', count: 5, error: 429 }],
      };
    },
  };
}

describe('DashboardRegistry', () => {
  it('register adds a source', () => {
    const registry = new DashboardRegistry();
    expect(registry.size).toBe(0);

    registry.register('test', createMockSource('test'));
    expect(registry.size).toBe(1);
  });

  it('unregister removes a source', () => {
    const registry = new DashboardRegistry();
    registry.register('test', createMockSource('test'));
    expect(registry.size).toBe(1);

    registry.unregister('test');
    expect(registry.size).toBe(0);
  });

  it('snapshot returns all registered sources', () => {
    const registry = new DashboardRegistry();
    registry.register('src1', createMockSource('src1'));
    registry.register('src2', createMockSource('src2'));

    const msg = registry.snapshot();
    expect(msg.type).toBe('snapshot');
    expect(msg.sources).toHaveLength(2);
    expect(msg.sources[0]?.name).toBe('src1');
    expect(msg.sources[1]?.name).toBe('src2');
    expect(msg.sources[0]?.snapshot.allowed).toBe(101);
    expect(msg.sources[1]?.snapshot.allowed).toBe(101);
  });

  it('snapshot returns empty array when no sources', () => {
    const registry = new DashboardRegistry();
    const msg = registry.snapshot();

    expect(msg.type).toBe('snapshot');
    expect(msg.sources).toHaveLength(0);
    expect(typeof msg.timestamp).toBe('number');
  });

  it('size property reflects count', () => {
    const registry = new DashboardRegistry();
    expect(registry.size).toBe(0);

    registry.register('a', createMockSource('a'));
    expect(registry.size).toBe(1);

    registry.register('b', createMockSource('b'));
    expect(registry.size).toBe(2);

    registry.unregister('a');
    expect(registry.size).toBe(1);

    registry.unregister('b');
    expect(registry.size).toBe(0);
  });

  it('unregister non-existent source does not throw', () => {
    const registry = new DashboardRegistry();
    expect(() => registry.unregister('nonexistent')).not.toThrow();
  });

  it('registering same name twice overwrites', () => {
    const registry = new DashboardRegistry();
    registry.register('test', createMockSource('test'));
    registry.register('test', createMockSource('test2'));
    expect(registry.size).toBe(1);
  });
});
