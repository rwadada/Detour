import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import type { DashboardServerMessage } from '../../domain/dashboard/protocol';
import { DetourEventBus } from '../eventBus';
import { startDashboardServer, type DashboardServerHandle } from './dashboardServer';

/**
 * Covers `lanInfo` (issue #66's sidebar LAN Access section): the dashboard
 * server broadcasts every LAN address it was told about so a connected
 * client can render the actual URL(s) another device on the network should
 * use, rather than only ever knowing the address the current tab's own
 * `window.location` happens to be. `options.lanAddresses` is the caller's
 * own precomputed list (see `DashboardServerOptions.lanAddresses`'s doc
 * comment) — this only covers that it's relayed to clients as-is, not how
 * `cli.ts` decides what to pass.
 */
describe('startDashboardServer — lanInfo (issue #66)', () => {
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

  it('broadcasts an empty address list when lanAddresses is omitted (localhost-only, the default)', async () => {
    const eventBus = new DetourEventBus();
    handle = await startDashboardServer({ port: 0 }, eventBus);
    sockets = [];
    const socket = connect();

    const message = await waitForMessage(socket, (m) => m.type === 'lanInfo');
    expect(message).toEqual({ type: 'lanInfo', addresses: [] });
  });

  it('broadcasts the given LAN addresses right after connecting', async () => {
    const eventBus = new DetourEventBus();
    // Fake test fixture addresses, not a real machine's — see the eslint-disable below.
    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- private-range test fixtures (RFC 1918), not real addresses.
    const fakeAddresses = ['192.168.1.5', '10.0.0.7'];
    handle = await startDashboardServer({ port: 0, lanAddresses: fakeAddresses }, eventBus);
    sockets = [];
    const socket = connect();

    const message = await waitForMessage(socket, (m) => m.type === 'lanInfo');
    expect(message).toEqual({ type: 'lanInfo', addresses: fakeAddresses });
  });
});
