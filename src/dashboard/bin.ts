#!/usr/bin/env node

import { createDashboard } from './server.js';
import type { AnalyticsSnapshot } from '../analytics/types.js';

// ---------------------------------------------------------------------------
// Demo analytics source
// ---------------------------------------------------------------------------
function createDemoSource(name: string): { name: string; analytics(): AnalyticsSnapshot } {
  return {
    name,
    analytics(): AnalyticsSnapshot {
      const allowed = Math.floor(Math.random() * 900) + 100;
      const denied = Math.floor(Math.random() * 50) + 1;
      const total = allowed + denied;
      return {
        allowed,
        denied,
        total,
        denyRate: total > 0 ? denied / total : 0,
        topRequested: [
          { key: '/api/users', count: Math.floor(Math.random() * 400) + 50, error: 0 },
          { key: '/api/posts', count: Math.floor(Math.random() * 300) + 30, error: 0 },
          { key: '/api/comments', count: Math.floor(Math.random() * 200) + 20, error: 0 },
        ],
        topDenied: [
          { key: '/api/admin', count: Math.floor(Math.random() * 20) + 1, error: 429 },
          { key: '/api/internal', count: Math.floor(Math.random() * 10) + 1, error: 403 },
        ],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
function parsePort(): number {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1] !== undefined) {
      const port = Number(args[i + 1]);
      if (!Number.isNaN(port) && port > 0 && port < 65536) {
        return port;
      }
    }
  }
  return 4000;
}

async function main(): Promise<void> {
  const port = parsePort();

  const dashboard = createDashboard({
    port,
    host: 'localhost',
    refreshMs: 2000,
  });

  // Register demo sources
  dashboard.registry.register('api-gateway', createDemoSource('api-gateway'));
  dashboard.registry.register('auth-service', createDemoSource('auth-service'));

  const info = await dashboard.start();
  console.log(`\n  🚀 ThrottleKit Dashboard running at:\n`);
  console.log(`     ${info.url}\n`);
  console.log(`  Press Ctrl+C to stop.\n`);

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n  Shutting down...');
    await dashboard.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Failed to start dashboard:', err);
  process.exit(1);
});
