import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { DetourEventBus } from '../eventBus';
import { startDashboardServer, type DashboardServerHandle } from './dashboardServer';

/**
 * Covers `dashboardCompression` (issue #165's Proposal D — see its own doc
 * comment on `DashboardServerOptions` for the measurement behind why this
 * defaults to off). Checked at the WebSocket handshake level — the
 * `Sec-WebSocket-Extensions` response header `ws` sets once it and a
 * client have negotiated `permessage-deflate` — rather than by inspecting
 * broadcast payload bytes, since that's the one place this option's actual
 * effect (whether the extension is offered to a client at all) is directly
 * observable without depending on `ws`'s own internal compression behavior.
 */
describe('startDashboardServer — dashboardCompression (issue #165)', () => {
  let handle: DashboardServerHandle | undefined;

  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
  });

  function negotiatedExtensions(port: number): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://localhost:${port}/ws`);
      socket.on('upgrade', (res) => {
        resolve(res.headers['sec-websocket-extensions']);
        socket.close();
      });
      socket.on('error', reject);
    });
  }

  it('negotiates permessage-deflate on /ws once dashboardCompression is turned on', async () => {
    const eventBus = new DetourEventBus();
    handle = await startDashboardServer({ port: 0, dashboardCompression: true }, eventBus);
    const extensions = await negotiatedExtensions(handle.port);
    expect(extensions).toContain('permessage-deflate');
  });

  it('never negotiates permessage-deflate when dashboardCompression is omitted (the default)', async () => {
    const eventBus = new DetourEventBus();
    handle = await startDashboardServer({ port: 0 }, eventBus);
    const extensions = await negotiatedExtensions(handle.port);
    expect(extensions).toBeUndefined();
  });

  it('never negotiates permessage-deflate when dashboardCompression is explicitly false', async () => {
    const eventBus = new DetourEventBus();
    handle = await startDashboardServer({ port: 0, dashboardCompression: false }, eventBus);
    const extensions = await negotiatedExtensions(handle.port);
    expect(extensions).toBeUndefined();
  });
});
