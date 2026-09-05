import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DashboardServerMessage } from '../../domain/dashboard/protocol';
import { DetourEventBus } from '../eventBus';
import { startDashboardServer, type DashboardServerHandle } from './dashboardServer';

/**
 * Covers the dashboard Settings panel's `userConfig`/`setUserConfig` wiring
 * (the follow-up letting `defaultDetach`/`lanAccess` — otherwise only set via
 * `detour config` — be edited from the dashboard too) directly against a
 * real `~/.detour/config.json`-shaped file, the same way
 * `dashboardServer.rules.test.ts` exercises the Rules editor's wiring.
 */
describe('startDashboardServer — userConfig / setUserConfig', () => {
  let dir: string;
  let configPath: string;
  let eventBus: DetourEventBus;
  let handle: DashboardServerHandle | undefined;
  let sockets: WebSocket[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-dashboard-userconfig-test-'));
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

  it('sends defaultDetach/lanAccess = false right after connecting when no config file exists', async () => {
    handle = await startDashboardServer({ port: 0, userConfigPath: configPath }, eventBus);
    const socket = connect();
    const message = await waitForMessage(socket, (m) => m.type === 'userConfig');
    expect(message).toEqual({ type: 'userConfig', state: { defaultDetach: false, lanAccess: false } });
  });

  it('sends the config file contents right after connecting when one already exists', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ defaultDetach: true }));
    handle = await startDashboardServer({ port: 0, userConfigPath: configPath }, eventBus);
    const socket = connect();
    const message = await waitForMessage(socket, (m) => m.type === 'userConfig');
    expect(message).toEqual({ type: 'userConfig', state: { defaultDetach: true, lanAccess: false } });
  });

  it('setUserConfig persists a partial change and broadcasts the merged state back', async () => {
    handle = await startDashboardServer({ port: 0, userConfigPath: configPath }, eventBus);
    const socket = connect();
    await waitForMessage(socket, (m) => m.type === 'userConfig'); // initial snapshot

    socket.send(JSON.stringify({ type: 'setUserConfig', state: { lanAccess: true } }));
    const updated = await waitForMessage(socket, (m) => m.type === 'userConfig' && m.state.lanAccess === true);

    expect(updated).toEqual({ type: 'userConfig', state: { defaultDetach: false, lanAccess: true } });
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({ lanAccess: true });
  });

  it('setUserConfig on one field never clobbers another already set', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ defaultDetach: true }));
    handle = await startDashboardServer({ port: 0, userConfigPath: configPath }, eventBus);
    const socket = connect();
    await waitForMessage(socket, (m) => m.type === 'userConfig'); // initial snapshot

    socket.send(JSON.stringify({ type: 'setUserConfig', state: { lanAccess: true } }));
    await waitForMessage(socket, (m) => m.type === 'userConfig' && m.state.lanAccess === true);

    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({ defaultDetach: true, lanAccess: true });
  });

  it('falls back to defaults on connect (rather than crashing the connection) when the existing config is invalid', async () => {
    fs.writeFileSync(configPath, '{ not json');
    handle = await startDashboardServer({ port: 0, userConfigPath: configPath }, eventBus);
    const socket = connect();
    const message = await waitForMessage(socket, (m) => m.type === 'userConfig');
    expect(message).toEqual({ type: 'userConfig', state: { defaultDetach: false, lanAccess: false } });
  });

  it('setUserConfig broadcasts a USER_CONFIG_WRITE_ERROR (and leaves the file untouched) when the existing config is invalid', async () => {
    fs.writeFileSync(configPath, '{ not json');
    handle = await startDashboardServer({ port: 0, userConfigPath: configPath }, eventBus);
    const socket = connect();
    await waitForMessage(socket, (m) => m.type === 'userConfig'); // initial (fallback) snapshot

    socket.send(JSON.stringify({ type: 'setUserConfig', state: { lanAccess: true } }));
    const error = await waitForMessage(socket, (m) => m.type === 'error');

    expect(error).toMatchObject({ type: 'error', event: { errorKind: 'USER_CONFIG_WRITE_ERROR' } });
    expect(fs.readFileSync(configPath, 'utf8')).toBe('{ not json');
  });
});
