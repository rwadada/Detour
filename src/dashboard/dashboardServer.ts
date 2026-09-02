import http from 'node:http';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { DetourEventBus } from '../eventBus';
import { assertPortAvailable } from '../portCheck';
import { RingBuffer } from '../ringBuffer';
import type { CapturedExchange, DetourEvents, FocusState, InterceptState, ThrottleState } from '../types';
import type { DashboardClientMessage, DashboardServerMessage } from './protocol';
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
  // Mirrors the proxy server's own `interceptEnabled` (which is the source
  // of truth) so a newly-connecting client can be told the current state
  // without a round trip — kept in sync via the `interceptChanged` event,
  // the same way `backlog` mirrors traffic.
  let interceptState: InterceptState = { enabled: true };
  // Mirrors the proxy server's own `focusHosts` the same way, kept in sync
  // via `focusChanged`.
  let focusState: FocusState = { hosts: [] };
  // Mirrors the proxy server's own `throttleState` the same way, kept in
  // sync via `throttleChanged`.
  let throttleState: ThrottleState = { enabled: false, downKbps: 0, upKbps: 0, latencyMs: 0, packetLossPct: 0 };

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
  // A `breakpoint` rule paused an exchange — broadcast it to every connected
  // tab so all of them can show/edit it, not just the one that happens to be
  // focused.
  const onBreakpointHit: DetourEvents['breakpointHit'] = ({ exchange, payload }) =>
    broadcast({ type: 'breakpoint', exchange, payload });
  const onInterceptChanged: DetourEvents['interceptChanged'] = (state) => {
    interceptState = state;
    broadcast({ type: 'intercept', state });
  };
  const onFocusChanged: DetourEvents['focusChanged'] = (state) => {
    focusState = state;
    broadcast({ type: 'focus', state });
  };
  const onThrottleChanged: DetourEvents['throttleChanged'] = (state) => {
    throttleState = state;
    broadcast({ type: 'throttle', state });
  };

  wss.on('connection', (socket: WebSocket) => {
    const backlogMessage: DashboardServerMessage = { type: 'backlog', items: backlog.toArray() };
    socket.send(JSON.stringify(backlogMessage));
    const interceptMessage: DashboardServerMessage = { type: 'intercept', state: interceptState };
    socket.send(JSON.stringify(interceptMessage));
    const focusMessage: DashboardServerMessage = { type: 'focus', state: focusState };
    socket.send(JSON.stringify(focusMessage));
    const throttleMessage: DashboardServerMessage = { type: 'throttle', state: throttleState };
    socket.send(JSON.stringify(throttleMessage));

    // The only browser → server traffic on this socket: resuming/aborting a
    // paused breakpoint, toggling intercept on/off, editing the Focus host
    // allowlist, and editing the Throttle profile. All are relayed onto the
    // event bus, where the proxy server is waiting on them (see
    // proxyServer.ts's
    // `waitForBreakpoint`/`handleSetIntercept`/`handleSetFocus`/`handleSetThrottle`).
    socket.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as DashboardClientMessage;
        if (message.type === 'breakpointResume') eventBus.emit('breakpointResume', message.command);
        else if (message.type === 'setIntercept') eventBus.emit('setIntercept', message.enabled);
        else if (message.type === 'setFocus') eventBus.emit('setFocus', message.hosts);
        else if (message.type === 'setThrottle') eventBus.emit('setThrottle', message.state);
      } catch {
        // Ignore malformed frames rather than crashing the dashboard.
      }
    });
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
      eventBus.on('breakpointHit', onBreakpointHit);
      eventBus.on('interceptChanged', onInterceptChanged);
      eventBus.on('focusChanged', onFocusChanged);
      eventBus.on('throttleChanged', onThrottleChanged);

      const address = httpServer.address();
      const boundPort = typeof address === 'object' && address ? address.port : options.port;
      resolve({
        port: boundPort,
        stop: () =>
          new Promise<void>((res) => {
            eventBus.off('request', onRequest);
            eventBus.off('response', onResponse);
            eventBus.off('error', onError);
            eventBus.off('breakpointHit', onBreakpointHit);
            eventBus.off('interceptChanged', onInterceptChanged);
            eventBus.off('focusChanged', onFocusChanged);
            eventBus.off('throttleChanged', onThrottleChanged);
            for (const client of wss.clients) client.close();
            wss.close(() => httpServer.close(() => res()));
          }),
      });
    });
  });
}
