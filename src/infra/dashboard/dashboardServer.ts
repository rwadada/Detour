import http from 'node:http';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type {
  BlockHostsState,
  CapturedExchange,
  CapturedWebSocketConnection,
  DetourEvents,
  FocusState,
  InterceptState,
  ThrottleState,
} from '../../domain/exchange/types';
import { RingBuffer } from '../../domain/shared/ringBuffer';
import type { DashboardClientMessage, DashboardServerMessage } from '../../domain/dashboard/protocol';
import type { DetourEventBus } from '../eventBus';
import { assertPortAvailable } from '../portCheck';
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
  // Mirrors `backlog` above, but for WebSocket connections (issue #17) —
  // kept in its own buffer/message type since a connection's shape (a
  // stream of frames rather than one request/response pair) doesn't fit
  // alongside `CapturedExchange`.
  const wsBacklog = new RingBuffer<CapturedWebSocketConnection>(
    options.backlogSize ?? DEFAULT_BACKLOG_SIZE,
    (item) => item.id,
  );
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
  // Mirrors the proxy server's own `blockHostsState` the same way, kept in
  // sync via `blockHostsChanged`.
  let blockHostsState: BlockHostsState = { hosts: [], mode: 'forbidden' };

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
  const onBlockHostsChanged: DetourEvents['blockHostsChanged'] = (state) => {
    blockHostsState = state;
    broadcast({ type: 'blockHosts', state });
  };
  const onWsOpen: DetourEvents['wsOpen'] = (connection) => {
    wsBacklog.upsert(connection);
    broadcast({ type: 'wsOpen', connection });
  };
  const onWsFrame: DetourEvents['wsFrame'] = (connection) => {
    wsBacklog.upsert(connection);
    broadcast({ type: 'wsFrame', connection });
  };
  const onWsClose: DetourEvents['wsClose'] = (connection) => {
    wsBacklog.upsert(connection);
    broadcast({ type: 'wsClose', connection });
  };

  wss.on('connection', (socket: WebSocket) => {
    const backlogMessage: DashboardServerMessage = { type: 'backlog', items: backlog.toArray() };
    socket.send(JSON.stringify(backlogMessage));
    const wsBacklogMessage: DashboardServerMessage = { type: 'wsBacklog', items: wsBacklog.toArray() };
    socket.send(JSON.stringify(wsBacklogMessage));
    const interceptMessage: DashboardServerMessage = { type: 'intercept', state: interceptState };
    socket.send(JSON.stringify(interceptMessage));
    const focusMessage: DashboardServerMessage = { type: 'focus', state: focusState };
    socket.send(JSON.stringify(focusMessage));
    const throttleMessage: DashboardServerMessage = { type: 'throttle', state: throttleState };
    socket.send(JSON.stringify(throttleMessage));
    const blockHostsMessage: DashboardServerMessage = { type: 'blockHosts', state: blockHostsState };
    socket.send(JSON.stringify(blockHostsMessage));

    // The only browser → server traffic on this socket: resuming/aborting a
    // paused breakpoint, toggling intercept on/off, editing the Focus host
    // allowlist, editing the Throttle profile, and editing the Block Hosts
    // denylist. All are relayed onto the event bus, where the proxy server
    // is waiting on them (see proxyServer.ts's
    // `waitForBreakpoint`/`handleSetIntercept`/`handleSetFocus`/`handleSetThrottle`/`handleSetBlockHosts`).
    socket.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as DashboardClientMessage;
        if (message.type === 'breakpointResume') eventBus.emit('breakpointResume', message.command);
        else if (message.type === 'setIntercept') eventBus.emit('setIntercept', message.enabled);
        else if (message.type === 'setFocus') eventBus.emit('setFocus', message.hosts);
        else if (message.type === 'setThrottle') eventBus.emit('setThrottle', message.state);
        else if (message.type === 'setBlockHosts') eventBus.emit('setBlockHosts', message.state);
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
      eventBus.on('blockHostsChanged', onBlockHostsChanged);
      eventBus.on('wsOpen', onWsOpen);
      eventBus.on('wsFrame', onWsFrame);
      eventBus.on('wsClose', onWsClose);

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
            eventBus.off('blockHostsChanged', onBlockHostsChanged);
            eventBus.off('wsOpen', onWsOpen);
            eventBus.off('wsFrame', onWsFrame);
            eventBus.off('wsClose', onWsClose);
            for (const client of wss.clients) client.close();
            wss.close(() => httpServer.close(() => res()));
          }),
      });
    });
  });
}
