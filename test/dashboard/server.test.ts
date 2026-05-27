import { describe, it, expect, afterEach } from 'vitest';
import { createDashboard } from '../../src/dashboard/server.js';
import type { DashboardMessage } from '../../src/dashboard/types.js';
import type { AnalyticsSnapshot } from '../../src/analytics/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockSource(): { analytics(): AnalyticsSnapshot } {
  return {
    analytics() {
      return {
        allowed: 100,
        denied: 10,
        total: 110,
        denyRate: 10 / 110,
        topRequested: [{ key: '/api/users', count: 50, error: 0 }],
        topDenied: [{ key: '/api/admin', count: 5, error: 429 }],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DashboardServer HTTP', () => {
  const servers: Array<{ stop(): Promise<void> }> = [];

  afterEach(async () => {
    for (const s of servers) {
      try {
        await s.stop();
      } catch {
        // Already stopped
      }
    }
    servers.length = 0;
  });

  it('starts and stops without errors', async () => {
    const dashboard = createDashboard({ port: 0 });
    servers.push(dashboard);
    const info = await dashboard.start();
    expect(info.port).toBeGreaterThan(0);
    expect(info.port).toBeLessThan(65536);
    expect(info.url).toContain('localhost');
  });

  it('GET / returns HTML with status 200', async () => {
    const dashboard = createDashboard({ port: 0 });
    servers.push(dashboard);
    const info = await dashboard.start();

    const res = await fetch(info.url);
    expect(res.status).toBe(200);
    const contentType = res.headers.get('content-type') ?? '';
    expect(contentType).toContain('text/html');
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });

  it('GET /api/snapshot returns valid JSON DashboardMessage', async () => {
    const dashboard = createDashboard({ port: 0 });
    servers.push(dashboard);
    const info = await dashboard.start();

    const res = await fetch(`${info.url}/api/snapshot`);
    expect(res.status).toBe(200);
    const contentType = res.headers.get('content-type') ?? '';
    expect(contentType).toContain('application/json');

    const data = await res.json() as DashboardMessage;
    expect(data.type).toBe('snapshot');
    expect(typeof data.timestamp).toBe('number');
    expect(Array.isArray(data.sources)).toBe(true);
  });

  it('GET /api/snapshot includes registered source data', async () => {
    const dashboard = createDashboard({ port: 0 });
    servers.push(dashboard);

    dashboard.registry.register('test-source', createMockSource());

    const info = await dashboard.start();
    const res = await fetch(`${info.url}/api/snapshot`);
    const data = await res.json() as DashboardMessage;

    expect(data.sources).toHaveLength(1);
    expect(data.sources[0]?.name).toBe('test-source');
    expect(data.sources[0]?.snapshot.allowed).toBe(100);
    expect(data.sources[0]?.snapshot.denied).toBe(10);
  });

  it('GET /api/snapshot returns empty sources when none registered', async () => {
    const dashboard = createDashboard({ port: 0 });
    servers.push(dashboard);
    const info = await dashboard.start();

    const res = await fetch(`${info.url}/api/snapshot`);
    const data = await res.json() as DashboardMessage;

    expect(data.sources).toHaveLength(0);
  });

  it('sets CORS headers on all responses', async () => {
    const dashboard = createDashboard({ port: 0 });
    servers.push(dashboard);
    const info = await dashboard.start();

    const res = await fetch(info.url);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');

    const res2 = await fetch(`${info.url}/api/snapshot`);
    expect(res2.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('handles OPTIONS preflight', async () => {
    const dashboard = createDashboard({ port: 0 });
    servers.push(dashboard);
    const info = await dashboard.start();

    const res = await fetch(info.url, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('uses custom port when specified', async () => {
    const dashboard = createDashboard({ port: 0 });
    servers.push(dashboard);
    const info = await dashboard.start();
    expect(info.port).toBeGreaterThan(0);
  });
});

describe('DashboardServer WebSocket', () => {
  const servers: Array<{ stop(): Promise<void> }> = [];

  afterEach(async () => {
    for (const s of servers) {
      try {
        await s.stop();
      } catch {
        // Already stopped
      }
    }
    servers.length = 0;
  });

  it('WebSocket connection receives snapshot messages', async () => {
    const dashboard = createDashboard({ port: 0, refreshMs: 50 });
    servers.push(dashboard);

    dashboard.registry.register('test', createMockSource());

    const info = await dashboard.start();
    const wsUrl = info.url.replace(/^http/, 'ws');

    const ws = new WebSocket(wsUrl);

    const message = await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('WebSocket test timed out after 5s'));
      }, 5000);

      ws.onmessage = (event: MessageEvent) => {
        clearTimeout(timeout);
        try {
          resolve(JSON.parse(event.data as string));
        } catch (e) {
          reject(e);
        }
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('WebSocket connection error'));
      };
    });

    expect(message).toHaveProperty('type', 'snapshot');
    expect(Array.isArray(message.sources)).toBe(true);
    expect(typeof message.timestamp).toBe('number');

    ws.close();
  });

  it('multiple WebSocket clients all receive broadcasts', async () => {
    const dashboard = createDashboard({ port: 0, refreshMs: 50 });
    servers.push(dashboard);

    dashboard.registry.register('test', createMockSource());

    const info = await dashboard.start();
    const wsUrl = info.url.replace(/^http/, 'ws');

    const ws1 = new WebSocket(wsUrl);
    const ws2 = new WebSocket(wsUrl);

    const [msg1, msg2] = await Promise.all([
      new Promise<any>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('ws1 timeout')), 5000);
        ws1.onmessage = (e) => { clearTimeout(t); resolve(JSON.parse(e.data as string)); };
        ws1.onerror = () => { clearTimeout(t); reject(new Error('ws1 error')); };
      }),
      new Promise<any>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('ws2 timeout')), 5000);
        ws2.onmessage = (e) => { clearTimeout(t); resolve(JSON.parse(e.data as string)); };
        ws2.onerror = () => { clearTimeout(t); reject(new Error('ws2 error')); };
      }),
    ]);

    expect(msg1.type).toBe('snapshot');
    expect(msg2.type).toBe('snapshot');

    ws1.close();
    ws2.close();
  });
});
