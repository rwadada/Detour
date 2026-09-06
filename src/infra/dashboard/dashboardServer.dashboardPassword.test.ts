import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DashboardServerMessage } from '../../domain/dashboard/protocol';
import { DetourEventBus } from '../eventBus';
import { startDashboardServer, type DashboardServerHandle } from './dashboardServer';

/**
 * Covers the optional dashboard password (issue #66's second half — the
 * first half, `lanInfo`, is covered by `dashboardServer.lanInfo.test.ts`): a
 * lightweight gate on the `/ws` connection itself, since that's the one
 * channel carrying live traffic, rule contents, and every control message
 * (the static SPA assets `serveStatic` serves carry nothing sensitive, so
 * they're never gated — see `dashboardServer.ts`'s `sendInitialPayload`).
 */
describe('startDashboardServer — dashboard password (issue #66)', () => {
  let dir: string;
  let configPath: string;
  let eventBus: DetourEventBus;
  let handle: DashboardServerHandle | undefined;
  let sockets: WebSocket[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-dashboard-password-test-'));
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

  /** Never resolves on a matching message — used to assert something is *not* sent. */
  function expectNoMessage(
    socket: WebSocket,
    predicate: (message: DashboardServerMessage) => boolean,
    timeoutMs = 300,
  ): Promise<void> {
    return waitForMessage(socket, predicate, timeoutMs).then(
      () => Promise.reject(new Error('Expected no matching message, but one arrived')),
      () => undefined,
    );
  }

  it('sends the usual snapshot right after connecting when no password is configured', async () => {
    handle = await startDashboardServer({ port: 0, userConfigPath: configPath }, eventBus);
    const socket = connect();
    const message = await waitForMessage(socket, (m) => m.type === 'backlog');
    expect(message.type).toBe('backlog');
  });

  // A config that never had a password shouldn't start gating connections
  // just because it's unreadable for some unrelated reason — that's a
  // regular `userConfigMessage`-style "fall back to defaults" case, not a
  // security-relevant one (contrast the "already set" case covered further
  // below, where the fallback must go the other way).
  it('does not gate connections when the config is unreadable but a password was never successfully read', async () => {
    fs.writeFileSync(configPath, '{ not json');
    handle = await startDashboardServer({ port: 0, userConfigPath: configPath }, eventBus);
    const socket = connect();
    const message = await waitForMessage(socket, (m) => m.type === 'backlog');
    expect(message.type).toBe('backlog');
  });

  it('setDashboardPassword persists a hash (never the plaintext) and reports dashboardPasswordSet: true', async () => {
    handle = await startDashboardServer({ port: 0, userConfigPath: configPath }, eventBus);
    const socket = connect();
    await waitForMessage(socket, (m) => m.type === 'userConfig'); // initial snapshot, no password yet

    socket.send(JSON.stringify({ type: 'setDashboardPassword', password: 'hunter2' }));
    const updated = await waitForMessage(
      socket,
      (m) => m.type === 'userConfig' && m.state.dashboardPasswordSet === true,
    );
    expect(updated).toMatchObject({ type: 'userConfig', state: { dashboardPasswordSet: true } });

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { dashboardPasswordHash?: string };
    expect(onDisk.dashboardPasswordHash).toBeTruthy();
    expect(onDisk.dashboardPasswordHash).not.toContain('hunter2');
  });

  // Silently accepting '' would set a real, trivially-guessable password
  // while `dashboardPasswordSet` keeps reporting "on" — worse than not
  // setting one at all, since it looks protected. Mirrors `detour config
  // --dashboard-password`'s own guard on the CLI side.
  it('setDashboardPassword rejects an empty string rather than setting a trivially-guessable password', async () => {
    handle = await startDashboardServer({ port: 0, userConfigPath: configPath }, eventBus);
    const socket = connect();
    await waitForMessage(socket, (m) => m.type === 'userConfig');

    socket.send(JSON.stringify({ type: 'setDashboardPassword', password: '' }));
    const error = await waitForMessage(socket, (m) => m.type === 'error');
    expect(error).toMatchObject({ type: 'error', event: { errorKind: 'USER_CONFIG_WRITE_ERROR' } });
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('setDashboardPassword with null clears a previously-set password', async () => {
    handle = await startDashboardServer({ port: 0, userConfigPath: configPath }, eventBus);
    const socket = connect();
    await waitForMessage(socket, (m) => m.type === 'userConfig');
    socket.send(JSON.stringify({ type: 'setDashboardPassword', password: 'hunter2' }));
    await waitForMessage(socket, (m) => m.type === 'userConfig' && m.state.dashboardPasswordSet === true);

    socket.send(JSON.stringify({ type: 'setDashboardPassword', password: null }));
    const cleared = await waitForMessage(
      socket,
      (m) => m.type === 'userConfig' && m.state.dashboardPasswordSet === false,
    );
    expect(cleared).toMatchObject({ type: 'userConfig', state: { dashboardPasswordSet: false } });
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { dashboardPasswordHash?: string | null };
    expect(onDisk.dashboardPasswordHash).toBeNull();
  });

  it('sends authRequired instead of the snapshot to a new connection when a password is already configured', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ dashboardPasswordHash: 'deadbeef:cafe' }));
    handle = await startDashboardServer({ port: 0, userConfigPath: configPath }, eventBus);
    const socket = connect();

    const message = await waitForMessage(socket, () => true);
    expect(message).toEqual({ type: 'authRequired' });
    await expectNoMessage(socket, (m) => m.type === 'backlog');
  });

  it('login with the correct password unlocks the snapshot', async () => {
    handle = await startDashboardServer({ port: 0, userConfigPath: configPath }, eventBus);
    const setup = connect();
    await waitForMessage(setup, (m) => m.type === 'userConfig');
    setup.send(JSON.stringify({ type: 'setDashboardPassword', password: 'hunter2' }));
    await waitForMessage(setup, (m) => m.type === 'userConfig' && m.state.dashboardPasswordSet === true);

    const socket = connect();
    await waitForMessage(socket, (m) => m.type === 'authRequired');
    socket.send(JSON.stringify({ type: 'login', password: 'hunter2' }));

    const backlog = await waitForMessage(socket, (m) => m.type === 'backlog');
    expect(backlog.type).toBe('backlog');
  });

  it('login with the wrong password sends authFailed and keeps the socket locked', async () => {
    handle = await startDashboardServer({ port: 0, userConfigPath: configPath }, eventBus);
    const setup = connect();
    await waitForMessage(setup, (m) => m.type === 'userConfig');
    setup.send(JSON.stringify({ type: 'setDashboardPassword', password: 'hunter2' }));
    await waitForMessage(setup, (m) => m.type === 'userConfig' && m.state.dashboardPasswordSet === true);

    const socket = connect();
    await waitForMessage(socket, (m) => m.type === 'authRequired');
    // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- a deliberately-wrong test fixture, not a real credential.
    socket.send(JSON.stringify({ type: 'login', password: 'wrong-guess' }));

    const failed = await waitForMessage(socket, (m) => m.type === 'authFailed');
    expect(failed).toEqual({ type: 'authFailed' });
    await expectNoMessage(socket, (m) => m.type === 'backlog');
  });

  it('ignores every message other than login from an unauthenticated socket', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ dashboardPasswordHash: 'deadbeef:cafe' }));
    handle = await startDashboardServer({ port: 0, userConfigPath: configPath }, eventBus);
    const socket = connect();
    await waitForMessage(socket, (m) => m.type === 'authRequired');

    // A real password hash can't be forged from the client side, so this
    // exercises the guard the same way a stray/malicious message would: it
    // must never reach `handleRulesMessage`/`writeUserConfig`/etc. before
    // `login` has succeeded.
    socket.send(JSON.stringify({ type: 'setUserConfig', state: { lanAccess: true } }));
    await expectNoMessage(socket, (m) => m.type === 'userConfig' || m.type === 'error');
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({ dashboardPasswordHash: 'deadbeef:cafe' });
  });

  it('keeps broadcasting to a socket that connected before a password was set, even after one is added', async () => {
    handle = await startDashboardServer({ port: 0, userConfigPath: configPath }, eventBus);
    const early = connect();
    await waitForMessage(early, (m) => m.type === 'userConfig'); // connected while unauthenticated wasn't even a concept yet

    early.send(JSON.stringify({ type: 'setDashboardPassword', password: 'hunter2' }));
    await waitForMessage(early, (m) => m.type === 'userConfig' && m.state.dashboardPasswordSet === true);

    // `early` itself must still be treated as authenticated — broadcasts
    // (here, its own `setUserConfig` echo) keep reaching it.
    early.send(JSON.stringify({ type: 'setUserConfig', state: { lanAccess: true } }));
    const updated = await waitForMessage(early, (m) => m.type === 'userConfig' && m.state.lanAccess === true);
    expect(updated).toMatchObject({ type: 'userConfig', state: { lanAccess: true } });
  });

  // Regression coverage for a fail-open bug a review caught: `currentPasswordHash`
  // must not treat "the config failed to read" the same as "no password is
  // configured" once a password has actually been read successfully at
  // least once — otherwise corrupting `~/.detour/config.json` (a hand-edit
  // of some unrelated field is enough; `loadUserConfig` fails the whole
  // file, not just the bad key) would silently wave every new connection
  // straight through with no password prompt at all.
  it('keeps gating new connections if the config becomes unreadable after a password was already set', async () => {
    handle = await startDashboardServer({ port: 0, userConfigPath: configPath }, eventBus);
    const setup = connect();
    await waitForMessage(setup, (m) => m.type === 'userConfig');
    setup.send(JSON.stringify({ type: 'setDashboardPassword', password: 'hunter2' }));
    await waitForMessage(setup, (m) => m.type === 'userConfig' && m.state.dashboardPasswordSet === true);

    // Corrupt the file out from under the running server — same effect as a
    // hand-edit introducing an unrelated typo (e.g. `lanAccess: "yes"`).
    fs.writeFileSync(configPath, '{ not json');

    const socket = connect();
    const message = await waitForMessage(socket, () => true);
    expect(message).toEqual({ type: 'authRequired' });
    await expectNoMessage(socket, (m) => m.type === 'backlog');
  });

  // Regression coverage for a second review finding on the same fail-closed
  // fix above: `userConfigMessage` must report `dashboardPasswordSet` from
  // the same fail-closed-aware `currentPasswordHash()` connection-gating
  // actually uses — not a separate fresh (and, on a corrupt read, always
  // `false`-falling-back) read of its own, which would tell an already-
  // authenticated client "no password required" while new connections keep
  // getting locked out.
  it('keeps reporting dashboardPasswordSet: true even once the config is unreadable', async () => {
    handle = await startDashboardServer({ port: 0, userConfigPath: configPath }, eventBus);
    const setup = connect();
    await waitForMessage(setup, (m) => m.type === 'userConfig');
    setup.send(JSON.stringify({ type: 'setDashboardPassword', password: 'hunter2' }));
    await waitForMessage(setup, (m) => m.type === 'userConfig' && m.state.dashboardPasswordSet === true);

    // Corrupt the file out from under the running server — same effect as a
    // hand-edit introducing an unrelated typo (e.g. `lanAccess: "yes"`).
    fs.writeFileSync(configPath, '{ not json');

    // The correct password still verifies against the cached hash (see
    // `currentPasswordHash`'s doc comment) — this client authenticates
    // normally and gets the usual just-connected snapshot, which must still
    // say a password is required, not silently fall back to "off" just
    // because the file happens to be unreadable right now.
    const socket = connect();
    await waitForMessage(socket, (m) => m.type === 'authRequired');
    socket.send(JSON.stringify({ type: 'login', password: 'hunter2' }));

    const userConfig = await waitForMessage(socket, (m) => m.type === 'userConfig');
    expect(userConfig).toMatchObject({ type: 'userConfig', state: { dashboardPasswordSet: true } });
  });
});
