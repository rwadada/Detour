import net from 'node:net';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DashboardServerMessage } from '../../domain/dashboard/protocol';
import type { AdbReverseWatcher } from '../adb/adbReverseWatcher';
import { DetourEventBus } from '../eventBus';
import { startDashboardServer, type DashboardServerHandle } from './dashboardServer';

const TOKEN = 'adb-reverse-test-token-0123456789abcdef';

function fakeWatcher(usb = 0) {
  const stop = vi.fn<() => void>();
  const watcher: AdbReverseWatcher & { stop: typeof stop } = {
    stop,
    isRunning: () => true,
    connectedUsbDevices: () => usb,
  };
  return watcher;
}

/** The dashboard's switch for keeping `adb reverse` in place, over a real WebSocket. */
describe('startDashboardServer — adb reverse switch', () => {
  let handle: DashboardServerHandle | undefined;
  let sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    sockets = [];
    await handle?.stop();
    handle = undefined;
  });

  function connect(query = `?token=${TOKEN}`): WebSocket {
    const socket = new WebSocket(`ws://localhost:${handle?.port}/ws${query}`);
    sockets.push(socket);
    return socket;
  }

  function waitForMessage(
    socket: WebSocket,
    predicate: (m: DashboardServerMessage) => boolean,
  ): Promise<Extract<DashboardServerMessage, { type: 'adbReverseState' }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for a matching message')), 2000);
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as DashboardServerMessage;
        if (predicate(message)) {
          clearTimeout(timer);
          resolve(message as Extract<DashboardServerMessage, { type: 'adbReverseState' }>);
        }
      });
      socket.on('error', reject);
    });
  }

  const isState = (m: DashboardServerMessage) => m.type === 'adbReverseState';

  it('sends no adbReverseState when the switch is not configured', async () => {
    handle = await startDashboardServer({ port: 0, accessToken: TOKEN }, new DetourEventBus());
    const socket = connect();
    const seen: string[] = [];
    socket.on('message', (raw) => seen.push((JSON.parse(raw.toString()) as DashboardServerMessage).type));
    await waitForMessage(socket, (m) => m.type === 'historyStatus');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(seen).not.toContain('adbReverseState');
  });

  it('tells a connecting client the state, with canChange for a client that presented the token', async () => {
    handle = await startDashboardServer(
      { port: 0, accessToken: TOKEN, adbReverse: { port: 8080, start: () => fakeWatcher() } },
      new DetourEventBus(),
    );
    expect(await waitForMessage(connect(), isState)).toEqual({
      type: 'adbReverseState',
      enabled: false,
      usbDevices: 0,
      port: 8080,
      canChange: true,
    });
  });

  it('is already on when started with --adb-reverse, and reports the USB devices it sees', async () => {
    const start = vi.fn(() => fakeWatcher(2));
    handle = await startDashboardServer(
      { port: 0, accessToken: TOKEN, adbReverse: { port: 8080, start, enabledAtStart: true } },
      new DetourEventBus(),
    );
    expect(start).toHaveBeenCalledTimes(1);
    expect(await waitForMessage(connect(), isState)).toMatchObject({ enabled: true, usbDevices: 2 });
  });

  it('turns on for a verified client and tells every connected client', async () => {
    const start = vi.fn(() => fakeWatcher());
    handle = await startDashboardServer(
      { port: 0, accessToken: TOKEN, adbReverse: { port: 8080, start } },
      new DetourEventBus(),
    );
    const mine = connect();
    const other = connect();
    await waitForMessage(mine, isState);
    await waitForMessage(other, isState);

    const heardByOther = waitForMessage(other, (m) => m.type === 'adbReverseState' && m.enabled);
    mine.send(JSON.stringify({ type: 'setAdbReverse', enabled: true }));

    expect(await heardByOther).toMatchObject({ enabled: true });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('turns off again and stops the watcher', async () => {
    const watcher = fakeWatcher();
    handle = await startDashboardServer(
      { port: 0, accessToken: TOKEN, adbReverse: { port: 8080, start: () => watcher, enabledAtStart: true } },
      new DetourEventBus(),
    );
    const socket = connect();
    await waitForMessage(socket, isState);

    const off = waitForMessage(socket, (m) => m.type === 'adbReverseState' && !m.enabled);
    socket.send(JSON.stringify({ type: 'setAdbReverse', enabled: false }));
    expect(await off).toMatchObject({ enabled: false });
    expect(watcher.stop).toHaveBeenCalledTimes(1);
  });

  it('refuses a client that was merely let in (no password or token required, none presented): nothing starts, and it is told it cannot change it', async () => {
    const start = vi.fn(() => fakeWatcher());
    // No accessToken: the dashboard lets anyone in, which is exactly the client that must not be able to run adb.
    handle = await startDashboardServer({ port: 0, adbReverse: { port: 8080, start } }, new DetourEventBus());
    const socket = connect('');
    expect(await waitForMessage(socket, isState)).toMatchObject({ enabled: false, canChange: false });

    const answer = waitForMessage(socket, isState);
    socket.send(JSON.stringify({ type: 'setAdbReverse', enabled: true }));
    expect(await answer).toMatchObject({ enabled: false, canChange: false });
    expect(start).not.toHaveBeenCalled();
  });

  it('rejects a setAdbReverse whose enabled is not a boolean', async () => {
    const start = vi.fn(() => fakeWatcher());
    handle = await startDashboardServer(
      { port: 0, accessToken: TOKEN, adbReverse: { port: 8080, start } },
      new DetourEventBus(),
    );
    const socket = connect();
    await waitForMessage(socket, isState);
    socket.send(JSON.stringify({ type: 'setAdbReverse', enabled: 'yes' }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(start).not.toHaveBeenCalled();
  });

  it('stops the watcher the switch started when the server stops', async () => {
    const watcher = fakeWatcher();
    handle = await startDashboardServer(
      { port: 0, accessToken: TOKEN, adbReverse: { port: 8080, start: () => watcher } },
      new DetourEventBus(),
    );
    const socket = connect();
    await waitForMessage(socket, isState);
    const on = waitForMessage(socket, (m) => m.type === 'adbReverseState' && m.enabled);
    socket.send(JSON.stringify({ type: 'setAdbReverse', enabled: true }));
    await on;

    await handle.stop();
    handle = undefined;
    expect(watcher.stop).toHaveBeenCalled();
  });

  it('does not leave a watcher behind when the dashboard fails to start', async () => {
    const start = vi.fn(() => fakeWatcher());
    // A control API with no access token is refused after the switch exists but before the server is up.
    await expect(
      startDashboardServer(
        { port: 0, controlPort: 0, adbReverse: { port: 8080, start, enabledAtStart: true } },
        new DetourEventBus(),
      ),
    ).rejects.toThrow(/access token/);
    expect(start).not.toHaveBeenCalled();
  });

  it('does not leave a watcher behind when the control API cannot bind its port', async () => {
    const start = vi.fn(() => fakeWatcher());
    // The dashboard is up by then; only the control API's port is taken.
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const taken = (blocker.address() as net.AddressInfo).port;
    try {
      await expect(
        startDashboardServer(
          { port: 0, accessToken: TOKEN, controlPort: taken, adbReverse: { port: 8080, start, enabledAtStart: true } },
          new DetourEventBus(),
        ),
      ).rejects.toThrow(/EADDRINUSE/);
      expect(start).not.toHaveBeenCalled();
    } finally {
      blocker.close();
    }
  });
});
