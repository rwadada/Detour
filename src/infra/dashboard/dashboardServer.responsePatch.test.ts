import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import type { DashboardServerMessage } from '../../domain/dashboard/protocol';
import type { CapturedExchange } from '../../domain/exchange/types';
import { DetourEventBus } from '../eventBus';
import { startDashboardServer, type DashboardServerHandle } from './dashboardServer';

/**
 * Covers issue #165's Proposal C: the `response` broadcast carries only the
 * response-side diff, not the full exchange — `requestBody`/`requestHeaders`
 * already went out in full on this same id's `request` broadcast and never
 * change by the time `response` fires. `backlog` (what a newly-connecting
 * client is replayed) must still carry the complete exchange either way,
 * since it has no earlier `request` message of its own to have already
 * delivered those fields.
 */
describe("startDashboardServer — response broadcast omits requestBody/requestHeaders (issue #165's Proposal C)", () => {
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

  function exchange(overrides: Partial<CapturedExchange> = {}): CapturedExchange {
    return {
      id: 'ex-1',
      method: 'GET',
      url: 'https://api.example.com/widgets',
      host: 'api.example.com',
      isSSL: true,
      protocol: 'HTTP/1.1',
      requestHeaders: { accept: 'application/json' },
      requestBodySize: 0,
      startedAt: 0,
      responseBodySize: 0,
      ...overrides,
    };
  }

  it('sends the full exchange (requestBody/requestHeaders included) on request, and only the diff on response', async () => {
    const eventBus = new DetourEventBus();
    handle = await startDashboardServer({ port: 0 }, eventBus);
    sockets = [];
    const socket = connect();
    await waitForMessage(socket, (m) => m.type === 'backlog');

    const requestPromise = waitForMessage(socket, (m) => m.type === 'request');
    // The real proxy pipeline mutates one exchange object across both
    // phases (see dashboardServer.backlogMemory.test.ts's own regression
    // test for this same pattern) rather than emitting a fresh object per
    // event — mirrored here so this test exercises the same shape.
    const mutable = exchange({ requestBody: Buffer.from('{"q":1}') });
    eventBus.emit('request', mutable);
    const requestMessage = await requestPromise;
    expect(requestMessage).toMatchObject({
      type: 'request',
      exchange: { id: 'ex-1', requestHeaders: { accept: 'application/json' } },
    });
    if (requestMessage.type !== 'request') throw new Error('unreachable');
    expect(requestMessage.exchange.requestBody).toBe(Buffer.from('{"q":1}').toString('base64'));

    const responsePromise = waitForMessage(socket, (m) => m.type === 'response');
    mutable.statusCode = 200;
    mutable.responseBody = Buffer.from('{"ok":true}');
    mutable.responseBodySize = 11;
    eventBus.emit('response', mutable);
    const responseMessage = await responsePromise;
    expect(responseMessage).toMatchObject({ type: 'response', exchange: { id: 'ex-1', statusCode: 200 } });
    if (responseMessage.type !== 'response') throw new Error('unreachable');
    // The two fields this proposal drops are absent altogether, not merely
    // empty — `'requestBody' in exchange` would still be true for `{
    // requestBody: undefined }`, which wouldn't actually prove anything got
    // dropped off the wire (`JSON.stringify` already omits an `undefined`
    // property, so the message genuinely never carries the key either way,
    // but asserting the *parsed* object doesn't have it is what actually
    // pins down the broadcast's shape here).
    expect(responseMessage.exchange).not.toHaveProperty('requestBody');
    expect(responseMessage.exchange).not.toHaveProperty('requestHeaders');
    expect(responseMessage.exchange.responseBody).toBe(Buffer.from('{"ok":true}').toString('base64'));
  });

  it('still replays the complete exchange (requestBody/requestHeaders included) via backlog to a newly-connecting client', async () => {
    const eventBus = new DetourEventBus();
    handle = await startDashboardServer({ port: 0 }, eventBus);
    sockets = [];

    const mutable = exchange({ requestBody: Buffer.from('{"q":1}') });
    eventBus.emit('request', mutable);
    mutable.statusCode = 200;
    mutable.responseBody = Buffer.from('{"ok":true}');
    eventBus.emit('response', mutable);

    const socket = connect();
    const backlogMessage = await waitForMessage(socket, (m) => m.type === 'backlog');
    if (backlogMessage.type !== 'backlog') throw new Error('unreachable');
    expect(backlogMessage.items).toHaveLength(1);
    expect(backlogMessage.items[0]).toMatchObject({
      id: 'ex-1',
      requestHeaders: { accept: 'application/json' },
      statusCode: 200,
    });
    expect(backlogMessage.items[0]?.requestBody).toBe(Buffer.from('{"q":1}').toString('base64'));
    expect(backlogMessage.items[0]?.responseBody).toBe(Buffer.from('{"ok":true}').toString('base64'));
  });
});
