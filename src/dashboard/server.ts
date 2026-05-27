import http from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';
import type { DashboardOptions, DashboardMessage } from './types.js';
import { DashboardRegistry } from './registry.js';

// ---------------------------------------------------------------------------
// Default HTML fallback (ui.ts may not exist yet)
// ---------------------------------------------------------------------------
const DEFAULT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ThrottleKit Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; background: #0d1117; color: #e6edf3; padding: 2rem; }
    h1 { color: #58a6ff; margin-bottom: 1rem; }
    p { color: #8b949e; }
  </style>
</head>
<body>
  <h1>ThrottleKit Dashboard</h1>
  <p>Dashboard UI not available. Ensure ui.ts is built.</p>
</body>
</html>`;

// ---------------------------------------------------------------------------
// WebSocket frame encoding (RFC 6455, text frames only)
// ---------------------------------------------------------------------------
function encodeFrame(data: string): Buffer {
  const payload = Buffer.from(data, 'utf8');
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

// ---------------------------------------------------------------------------
// WebSocket handshake helper
// ---------------------------------------------------------------------------
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function computeAcceptKey(clientKey: string): string {
  const hash = crypto.createHash('sha1');
  hash.update(clientKey + WS_GUID);
  return hash.digest('base64');
}

// ---------------------------------------------------------------------------
// DashboardServer implementation
// ---------------------------------------------------------------------------
export interface DashboardServer {
  start(): Promise<{ port: number; url: string }>;
  stop(): Promise<void>;
  readonly registry: DashboardRegistry;
}

export function createDashboard(options?: DashboardOptions): DashboardServer {
  const registry = new DashboardRegistry();
  const opts: Required<DashboardOptions> = {
    port: options?.port ?? 4000,
    host: options?.host ?? 'localhost',
    refreshMs: options?.refreshMs ?? 1000,
  };

  let server: http.Server | undefined;
  const wsClients = new Set<net.Socket>();
  let broadcastTimer: ReturnType<typeof setInterval> | undefined;
  let currentHtml: string = DEFAULT_HTML;

  // -----------------------------------------------------------------------
  // CORS helper
  // -----------------------------------------------------------------------
  function setCorsHeaders(res: http.ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }

  // -----------------------------------------------------------------------
  // Broadcast snapshot to all WebSocket clients
  // -----------------------------------------------------------------------
  function broadcast(): void {
    const message = registry.snapshot();
    const raw = JSON.stringify(message);
    const frame = encodeFrame(raw);
    for (const client of wsClients) {
      try {
        client.write(frame);
      } catch {
        client.destroy();
        wsClients.delete(client);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Request handler
  // -----------------------------------------------------------------------
  function onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    setCorsHeaders(res);

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? '/';

    if (url === '/api/snapshot') {
      const message = registry.snapshot();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(message));
      return;
    }

    // Default: serve dashboard HTML
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(currentHtml);
  }

  // -----------------------------------------------------------------------
  // WebSocket upgrade handler
  // -----------------------------------------------------------------------
  function onUpgrade(
    req: http.IncomingMessage,
    socket: net.Socket,
    _head: Buffer,
  ): void {
    const key = req.headers['sec-websocket-key'];
    if (!key || req.url !== '/') {
      socket.destroy();
      return;
    }

    const acceptKey = computeAcceptKey(key);

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
      '\r\n',
    );

    wsClients.add(socket);

    socket.on('close', () => {
      wsClients.delete(socket);
    });

    socket.on('error', () => {
      wsClients.delete(socket);
    });
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------
  const dashboardServer: DashboardServer = {
    registry,

    async start(): Promise<{ port: number; url: string }> {
      // Try to load the real UI HTML
      try {
        const ui = await import('./ui.js');
        if (typeof ui.DASHBOARD_HTML === 'string') {
          currentHtml = ui.DASHBOARD_HTML;
        }
      } catch {
        // Fallback HTML stays
      }

      server = http.createServer(onRequest);
      server.on('upgrade', onUpgrade);

      return new Promise((resolve, reject) => {
        if (!server) {
          reject(new Error('Server not created'));
          return;
        }

        server.once('error', reject);

        server.listen(opts.port, opts.host, () => {
          const addr = server!.address();
          if (!addr || typeof addr === 'string') {
            reject(new Error('Failed to get server address'));
            return;
          }

          // Start broadcasting
          broadcastTimer = setInterval(broadcast, opts.refreshMs);

          resolve({
            port: addr.port,
            url: `http://${opts.host}:${addr.port}`,
          });
        });
      });
    },

    async stop(): Promise<void> {
      // Stop broadcasting
      if (broadcastTimer !== undefined) {
        clearInterval(broadcastTimer);
        broadcastTimer = undefined;
      }

      // Destroy all WebSocket connections (force close)
      for (const client of wsClients) {
        client.destroy();
      }
      wsClients.clear();

      // Close HTTP server
      if (server) {
        server.closeAllConnections?.();
        return new Promise((resolve) => {
          server!.close(() => {
            server = undefined;
            resolve();
          });
        });
      }
    },
  };

  return dashboardServer;
}
