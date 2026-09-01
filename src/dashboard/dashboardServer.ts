import http from 'node:http';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { DetourEventBus } from '../eventBus';
import { assertPortAvailable } from '../portCheck';
import { RingBuffer } from '../ringBuffer';
import type { CapturedExchange, DetourEvents } from '../types';
import type { DashboardServerMessage } from './protocol';
import { serveStatic } from './staticServer';

/**
 * How many recent exchanges are kept around to replay to a browser tab that
 * connects (or reconnects) mid-session. Bounded so a long-running `detour
 * start` can't grow this without limit — old entries are simply dropped once
 * a client has already seen them go by live.
 */
const DEFAULT_BACKLOG_SIZE = 500;

// Built dashboard SPA (see web/), copied here as `web-dist/` by `npm run
// build`. Two directories up from this file in both dev (src/dashboard →
// repo root) and prod (dist/dashboard → package root) layouts.
export const WEB_DIST_DIR = path.resolve(__dirname, '..', '..', 'web-dist');

export interface DashboardServerOptions {
  port: number;
  host?: string;
  /** @default 500 */
  backlogSize?: number;
}

export interface DashboardServerHandle {
  /** Port the dashboard actually bound to (relevant when options.port is 0). */
  port: number;
  stop(): Promise<void>;
}

/**
 * Serves the built dashboard (static files + a `/ws` WebSocket feed of live
 * traffic) on `options.port`. Every exchange published on the event bus is
 * broadcast to all connected browser tabs in real time; a bounded backlog is
 * replayed to newly-connected clients so refreshing the page doesn't lose
 * recent history.
 */
export async function startDashboardServer(
  options: DashboardServerOptions,
  eventBus: DetourEventBus,
): Promise<DashboardServerHandle> {
  const host = options.host ?? 'localhost';
  await assertPortAvailable(options.port, host);

  const backlog = new RingBuffer<CapturedExchange>(options.backlogSize ?? DEFAULT_BACKLOG_SIZE, (item) => item.id);

  const httpServer = http.createServer((req, res) => serveStatic(WEB_DIST_DIR, req, res));
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  const broadcast = (message: DashboardServerMessage) => {
    const payload = JSON.stringify(message);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  };

  const onRequest = (exchange: Readonly<CapturedExchange>) => {
    backlog.upsert(exchange);
    broadcast({ type: 'request', exchange });
  };
  const onResponse = (exchange: Readonly<CapturedExchange>) => {
    backlog.upsert(exchange);
    broadcast({ type: 'response', exchange });
  };
  const onError: DetourEvents['error'] = (event) => broadcast({ type: 'error', event });

  wss.on('connection', (socket: WebSocket) => {
    const message: DashboardServerMessage = { type: 'backlog', items: backlog.toArray() };
    socket.send(JSON.stringify(message));
  });

  return new Promise((resolve, reject) => {
    httpServer.on('error', reject);
    httpServer.listen(options.port, host, () => {
      // Only subscribed once bound: if listen() fails (e.g. a port grabbed by
      // another process in the gap since assertPortAvailable's check), there
      // must be no dangling event-bus listeners left over from this attempt.
      eventBus.on('request', onRequest);
      eventBus.on('response', onResponse);
      eventBus.on('error', onError);

      const address = httpServer.address();
      const boundPort = typeof address === 'object' && address ? address.port : options.port;
      resolve({
        port: boundPort,
        stop: () =>
          new Promise<void>((res) => {
            eventBus.off('request', onRequest);
            eventBus.off('response', onResponse);
            eventBus.off('error', onError);
            for (const client of wss.clients) client.close();
            wss.close(() => httpServer.close(() => res()));
          }),
      });
    });
  });
}
