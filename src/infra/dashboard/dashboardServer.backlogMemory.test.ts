import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import type { DashboardServerMessage } from '../../domain/dashboard/protocol';
import type { CapturedExchange } from '../../domain/exchange/types';
import { DetourEventBus } from '../eventBus';
import { startDashboardServer, type DashboardServerHandle } from './dashboardServer';

/**
 * Covers `maxCaptureMemoryBytes` (issue #165's `--max-capture-memory`): the
 * backlog's total captured-body memory cap, independent of its item-count
 * cap (`backlogSize`) — a handful of large bodies can otherwise account for
 * hundreds of MB well before the count cap alone would evict anything. The
 * `RingBuffer.byteLimit` mechanism itself is covered in isolation by
 * `domain/shared/ringBuffer.test.ts`; this only checks the wiring —
 * `capturedExchangeByteSize` feeding `maxCaptureMemoryBytes` into the real
 * `backlog` a connecting client is sent.
 */
describe('startDashboardServer — backlog memory cap (issue #165)', () => {
  let handle: DashboardServerHandle | undefined;
  let sockets: WebSocket[];

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    await handle?.stop();
    handle = undefined;
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

  /** A finished exchange carrying a `responseBody` of exactly `bodyLength` base64 characters — enough to drive `capturedExchangeByteSize` deterministically without depending on real base64 encoding of specific bytes. */
  function exchangeWithBody(id: string, bodyLength: number): CapturedExchange {
    return {
      id,
      method: 'GET',
      url: `https://api.example.com/${id}`,
      host: 'api.example.com',
      isSSL: true,
      protocol: 'HTTP/1.1',
      requestHeaders: {},
      requestBodySize: 0,
      startedAt: 0,
      statusCode: 200,
      responseBodySize: bodyLength,
      responseBody: 'A'.repeat(bodyLength),
    };
  }

  it('evicts the oldest exchange once maxCaptureMemoryBytes is exceeded, before backlogSize would', async () => {
    const eventBus = new DetourEventBus();
    // backlogSize (10) never binds in this test — only the byte budget does.
    handle = await startDashboardServer({ port: 0, backlogSize: 10, maxCaptureMemoryBytes: 250 }, eventBus);
    sockets = [];

    eventBus.emit('response', exchangeWithBody('a', 100));
    eventBus.emit('response', exchangeWithBody('b', 100));
    eventBus.emit('response', exchangeWithBody('c', 100)); // 300 > 250 — evicts 'a'

    const socket = connect();
    const message = await waitForMessage(socket, (m) => m.type === 'backlog');
    expect(message.type).toBe('backlog');
    if (message.type !== 'backlog') throw new Error('unreachable');
    expect(message.items.map((e) => e.id)).toEqual(['b', 'c']);
  });

  it('does not evict by bytes at all when maxCaptureMemoryBytes is omitted (count-cap-only, pre-#165 behavior)', async () => {
    const eventBus = new DetourEventBus();
    handle = await startDashboardServer({ port: 0, backlogSize: 10 }, eventBus);
    sockets = [];

    eventBus.emit('response', exchangeWithBody('a', 100));
    eventBus.emit('response', exchangeWithBody('b', 100));
    eventBus.emit('response', exchangeWithBody('c', 100));

    const socket = connect();
    const message = await waitForMessage(socket, (m) => m.type === 'backlog');
    expect(message.type).toBe('backlog');
    if (message.type !== 'backlog') throw new Error('unreachable');
    expect(message.items.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });
});
