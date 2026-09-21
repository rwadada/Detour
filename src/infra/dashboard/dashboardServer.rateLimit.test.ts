import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DashboardServerMessage } from '../../domain/dashboard/protocol';
import { DetourEventBus } from '../eventBus';
import { startDashboardServer, type DashboardServerHandle } from './dashboardServer';

/**
 * Login rate limiting (issue #159): `loginInFlight` (see
 * `dashboardServer.dashboardPassword.test.ts`) only ever guarded two
 * `login` frames racing each other on the *same* socket — sequential
 * attempts, or attempts spread across several sockets, had nothing slowing
 * them down. These tests cover the two acceptance criteria that close that:
 * a socket that fails 5 times gets disconnected (and can't just reconnect
 * to reset the count), and an IP can't hold more than a few unauthenticated
 * sockets open at once.
 */
describe('startDashboardServer — login rate limiting (issue #159)', () => {
  let dir: string;
  let configPath: string;
  let eventBus: DetourEventBus;
  let handle: DashboardServerHandle | undefined;
  let sockets: WebSocket[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-dashboard-ratelimit-test-'));
    configPath = path.join(dir, 'config.json');
    eventBus = new DetourEventBus();
    sockets = [];
  });

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    await handle?.stop();
    handle = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function connect(): WebSocket {
    const socket = new WebSocket(`ws://localhost:${handle?.port}/ws`);
    sockets.push(socket);
    return socket;
  }

  function waitForMessage(
    socket: WebSocket,
    predicate: (message: DashboardServerMessage) => boolean,
    timeoutMs = 5000,
  ): Promise<DashboardServerMessage> {
    return new Promise((resolve, reject) => {
      // Detaches every listener this call added and clears its timer,
      // whichever of resolve/reject/timeout fires first (Copilot review) —
      // several of these tests call `waitForMessage` more than once on the
      // same socket, so leaving listeners attached would accumulate them.
      const cleanup = () => {
        clearTimeout(timer);
        socket.off('message', onMessage);
        socket.off('error', onError);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for a matching message'));
      }, timeoutMs);
      const onMessage = (raw: WebSocket.RawData) => {
        const message = JSON.parse(raw.toString()) as DashboardServerMessage;
        if (predicate(message)) {
          cleanup();
          resolve(message);
        }
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      socket.on('message', onMessage);
      socket.on('error', onError);
    });
  }

  function waitForClose(socket: WebSocket, timeoutMs = 5000): Promise<{ code: number; reason: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for the socket to close')), timeoutMs);
      socket.once('close', (code, reason) => {
        clearTimeout(timer);
        resolve({ code, reason: reason.toString() });
      });
    });
  }

  async function setPassword(password: string): Promise<void> {
    const setup = connect();
    await waitForMessage(setup, (m) => m.type === 'userConfig');
    setup.send(JSON.stringify({ type: 'setDashboardPassword', password }));
    await waitForMessage(setup, (m) => m.type === 'userConfig' && m.state.dashboardPasswordSet === true);
    setup.close();
  }

  /** Sends one wrong-password `login` attempt and waits for its `authFailed`. */
  async function failLogin(socket: WebSocket): Promise<void> {
    // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- a deliberately-wrong test fixture, not a real credential.
    socket.send(JSON.stringify({ type: 'login', password: 'wrong-guess' }));
    await waitForMessage(socket, (m) => m.type === 'authFailed');
  }

  it('disconnects a socket (code 1008) after its 5th consecutive login failure', async () => {
    handle = await startDashboardServer({ port: 0, userConfigPath: configPath }, eventBus);
    await setPassword('hunter2');

    const socket = connect();
    await waitForMessage(socket, (m) => m.type === 'authRequired');
    for (let i = 0; i < 4; i++) await failLogin(socket);
    // The 5th failure both answers with authFailed *and* closes the socket —
    // race the close against another authFailed wait rather than assuming
    // which one a listener attached after sending sees first.
    const closed = waitForClose(socket);
    // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- a deliberately-wrong test fixture, not a real credential.
    socket.send(JSON.stringify({ type: 'login', password: 'wrong-guess' }));
    const { code } = await closed;
    expect(code).toBe(1008);
  }, 10_000);

  it('does not disconnect before the 5th failure', async () => {
    handle = await startDashboardServer({ port: 0, userConfigPath: configPath }, eventBus);
    await setPassword('hunter2');

    const socket = connect();
    await waitForMessage(socket, (m) => m.type === 'authRequired');
    for (let i = 0; i < 4; i++) await failLogin(socket);
    expect(socket.readyState).toBe(WebSocket.OPEN);
  }, 10_000);

  // The whole point of counting by IP rather than per-socket: closing a
  // socket and opening a fresh one is free, so if the counter reset on
  // reconnect it would defend nothing.
  it('rejects a fresh socket from the same IP once that IP has already failed 5 times', async () => {
    handle = await startDashboardServer({ port: 0, userConfigPath: configPath }, eventBus);
    await setPassword('hunter2');

    const first = connect();
    await waitForMessage(first, (m) => m.type === 'authRequired');
    for (let i = 0; i < 4; i++) await failLogin(first);
    const firstClosed = waitForClose(first);
    // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- a deliberately-wrong test fixture, not a real credential.
    first.send(JSON.stringify({ type: 'login', password: 'wrong-guess' }));
    await firstClosed;

    const second = connect();
    const { code } = await waitForClose(second);
    expect(code).toBe(1008);
  }, 10_000);

  it('a successful login resets the failure count for that IP', async () => {
    handle = await startDashboardServer({ port: 0, userConfigPath: configPath }, eventBus);
    await setPassword('hunter2');

    const socket = connect();
    await waitForMessage(socket, (m) => m.type === 'authRequired');
    for (let i = 0; i < 3; i++) await failLogin(socket);
    socket.send(JSON.stringify({ type: 'login', password: 'hunter2' }));
    await waitForMessage(socket, (m) => m.type === 'backlog');

    // A fresh connection from the same IP isn't punished for the earlier
    // socket's near-miss run — it gets the normal authRequired greeting,
    // not an immediate 1008.
    const next = connect();
    const message = await waitForMessage(next, () => true);
    expect(message).toEqual({ type: 'authRequired' });
  }, 10_000);

  it('caps concurrent unauthenticated sockets per IP, rejecting the overflow', async () => {
    handle = await startDashboardServer({ port: 0, userConfigPath: configPath }, eventBus);
    await setPassword('hunter2');

    const held = [connect(), connect(), connect()];
    await Promise.all(held.map((s) => waitForMessage(s, (m) => m.type === 'authRequired')));

    const overflow = connect();
    const { code } = await waitForClose(overflow);
    expect(code).toBe(1008);
    // The three under the cap are unaffected by the overflow being rejected.
    for (const s of held) expect(s.readyState).toBe(WebSocket.OPEN);
  }, 10_000);

  it('authenticating frees its slot for a new unauthenticated connection from the same IP', async () => {
    handle = await startDashboardServer({ port: 0, userConfigPath: configPath }, eventBus);
    await setPassword('hunter2');

    const held = [connect(), connect(), connect()];
    await Promise.all(held.map((s) => waitForMessage(s, (m) => m.type === 'authRequired')));
    held[0]!.send(JSON.stringify({ type: 'login', password: 'hunter2' }));
    await waitForMessage(held[0]!, (m) => m.type === 'backlog');

    // One of the three slots is now held by an *authenticated* socket, not
    // an unauthenticated one — a new connection should fit in the freed slot
    // instead of overflowing.
    const next = connect();
    const message = await waitForMessage(next, () => true);
    expect(message).toEqual({ type: 'authRequired' });
  }, 10_000);

  it('closing an unauthenticated socket frees its slot too', async () => {
    handle = await startDashboardServer({ port: 0, userConfigPath: configPath }, eventBus);
    await setPassword('hunter2');

    const held = [connect(), connect(), connect()];
    await Promise.all(held.map((s) => waitForMessage(s, (m) => m.type === 'authRequired')));
    const closed = waitForClose(held[0]!);
    held[0]!.close();
    await closed;

    const next = connect();
    const message = await waitForMessage(next, () => true);
    expect(message).toEqual({ type: 'authRequired' });
  }, 10_000);

  it('does not rate-limit at all when no password is configured', async () => {
    handle = await startDashboardServer({ port: 0, userConfigPath: configPath }, eventBus);
    // No password set: every connection is grandfathered in immediately
    // (see dashboardServer.ts's own doc comment) and never touches the
    // unauthenticated-socket accounting this feature adds.
    const many = Array.from({ length: 5 }, () => connect());
    const messages = await Promise.all(many.map((s) => waitForMessage(s, (m) => m.type === 'backlog')));
    for (const message of messages) expect(message.type).toBe('backlog');
  }, 10_000);
});
