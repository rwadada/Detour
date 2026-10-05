import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DashboardServerMessage } from '../../domain/dashboard/protocol';
import type { UpdateService } from '../../domain/update/updateService';
import { DetourEventBus } from '../eventBus';
import { startDashboardServer, type DashboardServerHandle } from './dashboardServer';

function fakeService(
  overrides: Partial<UpdateService> = {},
): UpdateService & { startUpdate: ReturnType<typeof vi.fn> } {
  return {
    currentVersion: '1.0.0',
    canSelfUpdate: true,
    getLatestVersion: async () => '1.6.1',
    startUpdate: vi.fn(async () => {}),
    ...overrides,
  } as UpdateService & { startUpdate: ReturnType<typeof vi.fn> };
}

/** Self-update from the dashboard: the `updateInfo` snapshot and the `startUpdate` command. */
describe('startDashboardServer — update banner', () => {
  let handle: DashboardServerHandle | undefined;
  let sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    sockets = [];
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
    predicate: (m: DashboardServerMessage) => boolean,
  ): Promise<DashboardServerMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for a matching message')), 2000);
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as DashboardServerMessage;
        if (predicate(message)) {
          clearTimeout(timer);
          resolve(message);
        }
      });
      socket.on('error', reject);
    });
  }

  it('sends no updateInfo when no update service is configured', async () => {
    handle = await startDashboardServer({ port: 0 }, new DetourEventBus());
    const socket = connect();
    const seen: string[] = [];
    socket.on('message', (raw) => seen.push((JSON.parse(raw.toString()) as DashboardServerMessage).type));
    await waitForMessage(socket, (m) => m.type === 'historyStatus');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(seen).not.toContain('updateInfo');
  });

  it('tells a loopback client about the new release and that it may update', async () => {
    handle = await startDashboardServer({ port: 0, updateService: fakeService() }, new DetourEventBus());
    const message = await waitForMessage(connect(), (m) => m.type === 'updateInfo');
    expect(message).toEqual({
      type: 'updateInfo',
      current: '1.0.0',
      latest: '1.6.1',
      updateAvailable: true,
      canUpdate: true,
    });
  });

  it('launches the updater on startUpdate and acknowledges it', async () => {
    const updateService = fakeService();
    handle = await startDashboardServer({ port: 0, updateService }, new DetourEventBus());
    const socket = connect();
    await waitForMessage(socket, (m) => m.type === 'updateInfo');
    socket.send(JSON.stringify({ type: 'startUpdate' }));
    const status = await waitForMessage(socket, (m) => m.type === 'updateStatus');
    expect(status).toEqual({ type: 'updateStatus', state: 'started' });
    expect(updateService.startUpdate).toHaveBeenCalledTimes(1);
  });

  it('tells every tab when the updater exits without having restarted the server', async () => {
    const updateService = fakeService();
    handle = await startDashboardServer({ port: 0, updateService }, new DetourEventBus());
    const socket = connect();
    await waitForMessage(socket, (m) => m.type === 'updateInfo');
    socket.send(JSON.stringify({ type: 'startUpdate' }));
    await waitForMessage(socket, (m) => m.type === 'updateStatus');
    const failure = waitForMessage(socket, (m) => m.type === 'updateStatus' && m.state === 'failed');
    updateService.startUpdate.mock.calls[0]?.[0](1);
    expect(await failure).toMatchObject({ state: 'failed', message: expect.stringContaining('code 1') });
  });

  it('re-runs the release lookup on checkUpdate and answers with a fresh updateInfo', async () => {
    const getLatestVersion = vi.fn<(options?: { force?: boolean }) => Promise<string | null>>(async () => '1.0.0');
    handle = await startDashboardServer(
      { port: 0, updateService: fakeService({ getLatestVersion }) },
      new DetourEventBus(),
    );
    const socket = connect();
    const initial = await waitForMessage(socket, (m) => m.type === 'updateInfo');
    expect(initial).toMatchObject({ latest: '1.0.0', updateAvailable: false });
    getLatestVersion.mockResolvedValue('1.6.1');
    const refreshed = waitForMessage(socket, (m) => m.type === 'updateInfo' && m.latest === '1.6.1');
    socket.send(JSON.stringify({ type: 'checkUpdate' }));
    expect(await refreshed).toMatchObject({ latest: '1.6.1', updateAvailable: true });
    expect(getLatestVersion).toHaveBeenCalledWith({ force: true });
  });

  it('does not treat a client behind a same-host reverse proxy as local', async () => {
    handle = await startDashboardServer({ port: 0, updateService: fakeService() }, new DetourEventBus());
    const socket = new WebSocket(`ws://localhost:${handle.port}/ws`, { headers: { 'x-forwarded-for': '203.0.113.9' } });
    sockets.push(socket);
    const message = await waitForMessage(socket, (m) => m.type === 'updateInfo');
    expect(message).toMatchObject({ canUpdate: false });
  });

  it('rejects startUpdate for an install that cannot update itself', async () => {
    const updateService = fakeService({ canSelfUpdate: false });
    handle = await startDashboardServer({ port: 0, updateService }, new DetourEventBus());
    const socket = connect();
    const info = await waitForMessage(socket, (m) => m.type === 'updateInfo');
    expect(info).toMatchObject({ canUpdate: false, updateAvailable: true });
    socket.send(JSON.stringify({ type: 'startUpdate' }));
    const status = await waitForMessage(socket, (m) => m.type === 'updateStatus');
    expect(status).toMatchObject({ state: 'rejected' });
    expect(updateService.startUpdate).not.toHaveBeenCalled();
  });
});
