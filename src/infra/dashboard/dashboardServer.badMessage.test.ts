import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProxyErrorEvent } from '../../domain/exchange/types';
import { DetourEventBus } from '../eventBus';
import { startDashboardServer, type DashboardServerHandle } from './dashboardServer';

/** Issue #209: a bad frame or a throwing handler is reported, not swallowed. */
describe('startDashboardServer — malformed client messages', () => {
  let eventBus: DetourEventBus;
  let handle: DashboardServerHandle | undefined;
  let socket: WebSocket | undefined;
  let errors: ProxyErrorEvent[];

  beforeEach(() => {
    eventBus = new DetourEventBus();
    errors = [];
    eventBus.on('error', (event) => errors.push(event));
  });

  afterEach(async () => {
    socket?.close();
    await handle?.stop();
    handle = undefined;
    socket = undefined;
  });

  async function connect(): Promise<WebSocket> {
    handle = await startDashboardServer({ port: 0 }, eventBus);
    const ws = new WebSocket(`ws://localhost:${handle.port}/ws`);
    socket = ws;
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return ws;
  }

  const errorKinds = () => errors.map((e) => e.errorKind);

  it('reports a schema-invalid message and never acts on it', async () => {
    const ws = await connect();
    let throttleEvents = 0;
    eventBus.on('setThrottle', () => throttleEvents++);

    ws.send(JSON.stringify({ type: 'setThrottle', state: { enabled: 'yes' } }));

    await expect.poll(errorKinds).toContain('DASHBOARD_BAD_MESSAGE');
    expect(errors.find((e) => e.errorKind === 'DASHBOARD_BAD_MESSAGE')?.message).toContain('setThrottle');
    expect(throttleEvents).toBe(0);
  });

  it('reports non-JSON and unknown message types too', async () => {
    const ws = await connect();
    ws.send('not json');
    ws.send(JSON.stringify({ type: 'nope' }));
    await expect.poll(() => errorKinds().filter((k) => k === 'DASHBOARD_BAD_MESSAGE').length).toBe(2);
  });

  it('reports an exception thrown inside a message handler instead of swallowing it', async () => {
    const ws = await connect();
    eventBus.on('setIntercept', () => {
      throw new Error('boom');
    });

    ws.send(JSON.stringify({ type: 'setIntercept', enabled: true }));

    await expect.poll(errorKinds).toContain('DASHBOARD_HANDLER_ERROR');
    expect(errors.find((e) => e.errorKind === 'DASHBOARD_HANDLER_ERROR')?.message).toContain('boom');
  });
});
