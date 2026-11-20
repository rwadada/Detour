import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import type { DashboardServerMessage } from '../../domain/dashboard/protocol';
import type { AutoPassthroughState } from '../../domain/exchange/types';
import { DetourEventBus } from '../eventBus';
import { startDashboardServer, type DashboardServerHandle } from './dashboardServer';

/**
 * Issue #302: the dashboard shows auto TLS passthrough's state — whether it is on, and which targets are
 * relayed untouched right now — and can forget them all. The proxy owns the record; the dashboard asks it
 * for a fresh snapshot per connecting client and relays `autoPassthroughChanged` to everyone.
 */
describe('startDashboardServer — auto TLS passthrough (issue #302)', () => {
  let handle: DashboardServerHandle | undefined;
  let sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets) {
      socket.on('error', () => {});
      socket.terminate();
    }
    sockets = [];
    await handle?.stop();
    handle = undefined;
  });

  /** Attaches the listener before the connection opens: the snapshot is sent straight from the `connection` handler. */
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
    });
  }

  const recorded: AutoPassthroughState = {
    enabled: true,
    entries: [{ clientAddress: '127.0.0.1', host: 'api.example.com', port: 443, expiresAt: 1_900_000_000_000 }],
    total: 1,
  };

  it('sends the current state to a client as it connects', async () => {
    handle = await startDashboardServer({ port: 0, autoPassthroughState: () => recorded }, new DetourEventBus());
    const message = await waitForMessage(connect(), (m) => m.type === 'autoPassthrough');
    expect(message).toEqual({ type: 'autoPassthrough', state: recorded });
  });

  it('sends nothing about it when the proxy has no such state to offer', async () => {
    handle = await startDashboardServer({ port: 0 }, new DetourEventBus());
    const socket = connect();
    const seen: string[] = [];
    socket.on('message', (raw) => seen.push((JSON.parse(raw.toString()) as DashboardServerMessage).type));
    await waitForMessage(socket, (m) => m.type === 'historyStatus');
    expect(seen).not.toContain('autoPassthrough');
  });

  it('relays every change to every connected client', async () => {
    const eventBus = new DetourEventBus();
    handle = await startDashboardServer(
      { port: 0, autoPassthroughState: () => ({ enabled: true, entries: [], total: 0 }) },
      eventBus,
    );
    const first = connect();
    const second = connect();
    await Promise.all([first, second].map((s) => waitForMessage(s, (m) => m.type === 'autoPassthrough')));

    const updates = [first, second].map((s) =>
      waitForMessage(s, (m) => m.type === 'autoPassthrough' && m.state.entries.length === 1),
    );
    eventBus.emit('autoPassthroughChanged', recorded);
    for (const update of await Promise.all(updates)) {
      expect(update).toEqual({ type: 'autoPassthrough', state: recorded });
    }
  });

  it('passes a forgetAutoPassthrough request on to the proxy', async () => {
    const eventBus = new DetourEventBus();
    let forgotten = 0;
    eventBus.on('forgetAutoPassthrough', () => forgotten++);
    handle = await startDashboardServer({ port: 0, autoPassthroughState: () => recorded }, eventBus);
    const socket = connect();
    await waitForMessage(socket, (m) => m.type === 'autoPassthrough');

    socket.send(JSON.stringify({ type: 'forgetAutoPassthrough' }));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(forgotten).toBe(1);
  });
});
