import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import type { DashboardServerMessage } from '../../domain/dashboard/protocol';
import { DetourEventBus } from '../eventBus';
import { startDashboardServer, type DashboardServerHandle } from './dashboardServer';

/**
 * Covers `proxyInfo` (issue #24's sidebar Proxy URL / QR code): the
 * dashboard server broadcasts the proxy's port to every newly-connected
 * client so it can render the proxy's address without the client having to
 * back-compute it from its own port (which would break the moment
 * `--dashboard-port` is overridden independently of the `+1000` default).
 */
describe('startDashboardServer — proxyInfo (issue #24)', () => {
  let handle: DashboardServerHandle | undefined;
  let sockets: WebSocket[];

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    await handle?.stop();
    handle = undefined;
  });

  // Mirrors dashboardServer.rules.test.ts's `connect()`: deliberately does
  // NOT wait for the `open` event before returning. The server pushes its
  // initial snapshot messages synchronously from the `connection` handler,
  // which can arrive (and be parsed by `ws`) in the same synchronous pass
  // as `open` itself — awaiting `open` first, then attaching the `message`
  // listener, loses that race and drops every message sent before the
  // listener existed. Attaching `waitForMessage`'s listener immediately,
  // before the connection has even completed, sidesteps the race entirely.
  function connect(): WebSocket {
    const socket = new WebSocket(`ws://localhost:${handle?.port}/ws`);
    sockets.push(socket);
    return socket;
  }

  function waitForMessage(
    socket: WebSocket,
    predicate: (message: DashboardServerMessage) => boolean,
    timeoutMs = 2000,
  ): Promise<DashboardServerMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for a matching message')), timeoutMs);
      const onMessage = (raw: WebSocket.RawData) => {
        const message = JSON.parse(raw.toString()) as DashboardServerMessage;
        if (predicate(message)) {
          clearTimeout(timer);
          socket.off('message', onMessage);
          resolve(message);
        }
      };
      socket.on('message', onMessage);
      socket.on('error', reject);
    });
  }

  it('broadcasts proxyInfo right after connecting when proxyPort is configured', async () => {
    const eventBus = new DetourEventBus();
    handle = await startDashboardServer({ port: 0, proxyPort: 8080 }, eventBus);
    sockets = [];
    const socket = connect();

    const message = await waitForMessage(socket, (m) => m.type === 'proxyInfo');
    expect(message).toEqual({ type: 'proxyInfo', proxyPort: 8080 });
  });

  it('sends nothing proxyInfo-shaped when proxyPort is omitted (e.g. dashboard-only tests)', async () => {
    const eventBus = new DetourEventBus();
    handle = await startDashboardServer({ port: 0 }, eventBus);
    sockets = [];
    const socket = connect();
    // Attached synchronously, right after `connect()` — same race avoidance
    // as `waitForMessage` below, so this also catches whatever's sent first.
    const received: DashboardServerMessage[] = [];
    socket.on('message', (raw) => received.push(JSON.parse(raw.toString()) as DashboardServerMessage));

    // `backlog` (further down the just-connected snapshot — see
    // `sendInitialPayload`) rather than the very first message: `lanInfo` is
    // sent unconditionally too (issue #66) and arrives before it.
    await waitForMessage(socket, (m) => m.type === 'backlog');
    expect(received.some((m) => m.type === 'proxyInfo')).toBe(false);
  });
});
