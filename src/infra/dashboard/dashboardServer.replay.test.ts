import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import type { CapturedExchange } from '../../domain/exchange/types';
import type { DashboardServerMessage } from '../../domain/dashboard/protocol';
import type { HttpRequester } from '../../usecase/ports/httpRequester';
import { DetourEventBus } from '../eventBus';
import { startDashboardServer, type DashboardServerHandle } from './dashboardServer';

/**
 * Covers the `replay` wiring (issue #19) added to `startDashboardServer`.
 * `usecase/replayExchange.test.ts` covers the exchange-building logic
 * itself in isolation — this only checks that a `replay` client message
 * reaches it and the result comes back out over `/ws` as a normal
 * `request`/`response` pair, with a real `httpRequester` swapped for a fake
 * so this never touches the network.
 */
describe('startDashboardServer — Replay (issue #19)', () => {
  let handle: DashboardServerHandle | undefined;
  let sockets: WebSocket[];

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    await handle?.stop();
    handle = undefined;
  });

  function original(): CapturedExchange {
    return {
      id: 'original-1',
      method: 'GET',
      url: 'https://api.example.com/hello',
      host: 'api.example.com',
      isSSL: true,
      protocol: 'HTTP/1.1',
      requestHeaders: { accept: 'application/json' },
      requestBodySize: 0,
      startedAt: 0,
      responseBodySize: 0,
    };
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

  it('replays an exchange through the injected httpRequester and broadcasts the result', async () => {
    const eventBus = new DetourEventBus();
    const requester: HttpRequester = {
      request: async () => ({
        statusCode: 200,
        statusMessage: 'OK',
        headers: { 'content-type': 'text/plain' },
        body: Buffer.from('replayed-ok'),
      }),
    };
    handle = await startDashboardServer({ port: 0, httpRequester: requester }, eventBus);
    sockets = [];
    const socket = new WebSocket(`ws://localhost:${handle.port}/ws`);
    sockets.push(socket);
    await new Promise((resolve) => socket.on('open', resolve));

    socket.send(JSON.stringify({ type: 'replay', exchange: original() }));
    const response = await waitForMessage(socket, (m) => m.type === 'response' && m.exchange.id !== 'original-1');

    expect(response).toMatchObject({ type: 'response', exchange: { statusCode: 200, method: 'GET' } });
  });

  it('a failed outbound request still resolves as a `response` carrying `error`, not a crash or hang', async () => {
    const eventBus = new DetourEventBus();
    const requester: HttpRequester = {
      request: async () => {
        throw new Error('ECONNREFUSED');
      },
    };
    handle = await startDashboardServer({ port: 0, httpRequester: requester }, eventBus);
    sockets = [];
    const socket = new WebSocket(`ws://localhost:${handle.port}/ws`);
    sockets.push(socket);
    await new Promise((resolve) => socket.on('open', resolve));

    socket.send(JSON.stringify({ type: 'replay', exchange: original() }));
    const response = await waitForMessage(socket, (m) => m.type === 'response' && m.exchange.id !== 'original-1');

    expect(response).toMatchObject({ type: 'response', exchange: { error: 'ECONNREFUSED' } });
  });
});
