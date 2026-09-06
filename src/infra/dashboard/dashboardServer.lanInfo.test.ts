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
 * `cli.ts` decides what to pass (`cli.ts` now passes it regardless of this
 * server's own `host`, since the proxy it fronts always binds to every
 * interface — but that's `cli.ts`'s call, not this module's). `dashboardOnLan`
 * (also covered below) *is* this module's own to compute, from its own
 * `options.host`.
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

  it('broadcasts an empty address list, and dashboardOnLan: false, when lanAddresses/host are both omitted (the default)', async () => {
    const eventBus = new DetourEventBus();
    handle = await startDashboardServer({ port: 0 }, eventBus);
    sockets = [];
    const socket = connect();

    const message = await waitForMessage(socket, (m) => m.type === 'lanInfo');
    expect(message).toEqual({ type: 'lanInfo', addresses: [], dashboardOnLan: false });
  });

  it('broadcasts the given LAN addresses right after connecting, with dashboardOnLan: false when this server is still localhost-only itself', async () => {
    const eventBus = new DetourEventBus();
    // Fake test fixture addresses, not a real machine's — see the eslint-disable below.
    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- private-range test fixtures (RFC 1918), not real addresses.
    const fakeAddresses = ['192.168.1.5', '10.0.0.7'];
    // `host` deliberately left at its `localhost` default here — this is
    // exactly the shape the proxy's own always-LAN binding produces
    // (addresses non-empty, but *this* dashboard server not itself bound to
    // every interface): `lanAddresses` and `host`/`dashboardOnLan` are two
    // independent knobs, not one derived from the other.
    handle = await startDashboardServer({ port: 0, lanAddresses: fakeAddresses }, eventBus);
    sockets = [];
    const socket = connect();

    const message = await waitForMessage(socket, (m) => m.type === 'lanInfo');
    expect(message).toEqual({ type: 'lanInfo', addresses: fakeAddresses, dashboardOnLan: false });
  });

  it('reports dashboardOnLan: true when this server is itself bound to every interface (host: "0.0.0.0")', async () => {
    const eventBus = new DetourEventBus();
    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- private-range test fixture, not a real address.
    const fakeAddresses = ['192.168.1.5'];
    handle = await startDashboardServer({ port: 0, host: '0.0.0.0', lanAddresses: fakeAddresses }, eventBus);
    sockets = [];
    const socket = connect();

    const message = await waitForMessage(socket, (m) => m.type === 'lanInfo');
    expect(message).toEqual({ type: 'lanInfo', addresses: fakeAddresses, dashboardOnLan: true });
  });
});
