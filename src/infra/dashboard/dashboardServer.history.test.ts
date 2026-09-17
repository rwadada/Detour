import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import type { DashboardServerMessage } from '../../domain/dashboard/protocol';
import type { CapturedExchange } from '../../domain/exchange/types';
import { DetourEventBus } from '../eventBus';
import { isHistoryPersistenceSupported, openHistoryStore, type HistoryStore } from '../persistence/historyStore';
import { startDashboardServer, type DashboardServerHandle } from './dashboardServer';

function exchange(overrides: Partial<CapturedExchange> = {}): CapturedExchange {
  return {
    id: 'ex-1',
    method: 'GET',
    url: 'https://api.example.com/users',
    host: 'api.example.com',
    isSSL: true,
    protocol: 'HTTP/1.1',
    requestHeaders: {},
    requestBodySize: 0,
    responseBodySize: 0,
    startedAt: 1000,
    statusCode: 200,
    ...overrides,
  };
}

/**
 * Covers `historyStatus`/`queryHistory`/`historyResult` (issue #144's
 * optional `--persist` SQLite history) at the dashboard-server level: that
 * the wire messages are relayed correctly to/from a `HistoryStore`. The
 * store's own query/filter/pagination logic is `historyStore.test.ts`'s
 * concern; this only covers that `dashboardServer.ts` wires it up right —
 * `historyStatus` reflecting whether one is configured, and `queryHistory`
 * being answered (only the requesting socket, not broadcast) rather than
 * silently dropped.
 */
describe.skipIf(!isHistoryPersistenceSupported())('startDashboardServer — history (issue #144)', () => {
  let handle: DashboardServerHandle | undefined;
  let sockets: WebSocket[] = [];
  let store: HistoryStore | undefined;
  const dirs: string[] = [];

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    await handle?.stop();
    handle = undefined;
    store?.close();
    store = undefined;
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

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

  function tmpDbPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-dashboard-history-test-'));
    dirs.push(dir);
    return path.join(dir, 'history.db');
  }

  it('sends historyStatus: false when no --persist store is configured', async () => {
    const eventBus = new DetourEventBus();
    handle = await startDashboardServer({ port: 0 }, eventBus);
    sockets = [];
    const socket = connect();

    const message = await waitForMessage(socket, (m) => m.type === 'historyStatus');
    expect(message).toEqual({ type: 'historyStatus', enabled: false });
  });

  it('sends historyStatus: true when a store is configured', async () => {
    store = openHistoryStore(tmpDbPath());
    const eventBus = new DetourEventBus();
    handle = await startDashboardServer({ port: 0, historyStore: store }, eventBus);
    sockets = [];
    const socket = connect();

    const message = await waitForMessage(socket, (m) => m.type === 'historyStatus');
    expect(message).toEqual({ type: 'historyStatus', enabled: true });
  });

  it('answers queryHistory with an empty, hasMore: false result when no store is configured, rather than dropping it', async () => {
    const eventBus = new DetourEventBus();
    handle = await startDashboardServer({ port: 0 }, eventBus);
    sockets = [];
    const socket = connect();
    await waitForMessage(socket, (m) => m.type === 'historyStatus');

    socket.send(JSON.stringify({ type: 'queryHistory', requestId: 'req-1', query: { limit: 10 } }));
    const message = await waitForMessage(socket, (m) => m.type === 'historyResult');
    expect(message).toEqual({ type: 'historyResult', requestId: 'req-1', items: [], hasMore: false });
  });

  it('answers queryHistory with persisted exchanges, echoing requestId', async () => {
    store = openHistoryStore(tmpDbPath());
    store.record(exchange({ id: 'a', startedAt: 1000 }));
    store.record(exchange({ id: 'b', startedAt: 2000 }));
    const eventBus = new DetourEventBus();
    handle = await startDashboardServer({ port: 0, historyStore: store }, eventBus);
    sockets = [];
    const socket = connect();
    await waitForMessage(socket, (m) => m.type === 'historyStatus');

    socket.send(JSON.stringify({ type: 'queryHistory', requestId: 'req-42', query: { limit: 10 } }));
    const message = await waitForMessage(socket, (m) => m.type === 'historyResult');
    expect(message).toEqual({
      type: 'historyResult',
      requestId: 'req-42',
      items: [exchange({ id: 'b', startedAt: 2000 }), exchange({ id: 'a', startedAt: 1000 })],
      hasMore: false,
    });
  });

  it('answers only the requesting socket, not every connected tab', async () => {
    store = openHistoryStore(tmpDbPath());
    store.record(exchange());
    const eventBus = new DetourEventBus();
    handle = await startDashboardServer({ port: 0, historyStore: store }, eventBus);
    sockets = [];
    const requester = connect();
    const bystander = connect();
    await waitForMessage(requester, (m) => m.type === 'historyStatus');
    await waitForMessage(bystander, (m) => m.type === 'historyStatus');

    let bystanderSawResult = false;
    bystander.on('message', (raw) => {
      if ((JSON.parse(raw.toString()) as DashboardServerMessage).type === 'historyResult') {
        bystanderSawResult = true;
      }
    });

    requester.send(JSON.stringify({ type: 'queryHistory', requestId: 'req-1', query: { limit: 10 } }));
    await waitForMessage(requester, (m) => m.type === 'historyResult');
    // Give a wrongly-broadcast message a moment to arrive if it were sent.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(bystanderSawResult).toBe(false);
  });

  it('still answers queryHistory (rather than hanging the requester forever) when the store throws', async () => {
    const throwingStore: HistoryStore = {
      record: () => undefined,
      query: () => {
        throw new Error('database disk image is malformed');
      },
      close: () => undefined,
    };
    const eventBus = new DetourEventBus();
    const errors: unknown[] = [];
    eventBus.on('error', (event) => errors.push(event));
    handle = await startDashboardServer({ port: 0, historyStore: throwingStore }, eventBus);
    sockets = [];
    const socket = connect();
    await waitForMessage(socket, (m) => m.type === 'historyStatus');

    socket.send(JSON.stringify({ type: 'queryHistory', requestId: 'req-1', query: { limit: 10 } }));
    const message = await waitForMessage(socket, (m) => m.type === 'historyResult');

    expect(message).toEqual({ type: 'historyResult', requestId: 'req-1', items: [], hasMore: false });
    expect(errors).toEqual([{ errorKind: 'HISTORY_QUERY_ERROR', message: 'database disk image is malformed' }]);
  });
});
