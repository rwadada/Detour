/* eslint-disable sonarjs/no-hardcoded-ip -- peer-address fixtures */
import type { WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import type { UpdateService } from '../../domain/update/updateService';
import { createDashboardUpdates, hasForwardingHeaders, isLoopbackAddress } from './dashboardUpdates';

const socket = {} as WebSocket;

function setup(opts: { loopback?: boolean; verified?: boolean; canSelfUpdate?: boolean; latest?: string | null } = {}) {
  const startUpdate = vi.fn(async (_onExit: (exitCode: number | null) => void) => {});
  const onFailed = vi.fn();
  const service: UpdateService = {
    currentVersion: '1.0.0',
    canSelfUpdate: opts.canSelfUpdate ?? true,
    getLatestVersion: async () => (opts.latest === undefined ? '1.6.1' : opts.latest),
    startUpdate,
  };
  let clock = 0;
  const updates = createDashboardUpdates(
    service,
    { isLoopback: () => opts.loopback ?? false, isPasswordVerified: () => opts.verified ?? false },
    () => clock,
    onFailed,
  );
  return { updates, startUpdate, onFailed, advance: (ms: number) => (clock += ms) };
}

describe('isLoopbackAddress', () => {
  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.2'])('%s is loopback', (address) => {
    expect(isLoopbackAddress(address)).toBe(true);
  });
  it.each([undefined, '', '192.168.1.5', '::ffff:192.168.1.5', '10.0.0.1'])('%s is not loopback', (address) => {
    expect(isLoopbackAddress(address)).toBe(false);
  });
});

describe('hasForwardingHeaders', () => {
  it('flags requests that went through a reverse proxy', () => {
    expect(hasForwardingHeaders({ 'x-forwarded-for': '203.0.113.9' })).toBe(true);
    expect(hasForwardingHeaders({ forwarded: 'for=203.0.113.9' })).toBe(true);
    expect(hasForwardingHeaders({ host: 'localhost:9000' })).toBe(false);
  });
});

describe('createDashboardUpdates', () => {
  it('has nothing to report without an update service', async () => {
    const updates = createDashboardUpdates(undefined, { isLoopback: () => true, isPasswordVerified: () => true });
    expect(await updates.infoFor(socket)).toBeNull();
    expect((await updates.start(socket)).type).toBe('updateStatus');
  });

  it('reports a newer release and whether this socket may trigger it', async () => {
    const { updates } = setup({ loopback: true });
    expect(await updates.infoFor(socket)).toEqual({
      type: 'updateInfo',
      current: '1.0.0',
      latest: '1.6.1',
      updateAvailable: true,
      canUpdate: true,
    });
  });

  it('reports nothing available when up to date or when the lookup failed', async () => {
    const upToDate = setup({ latest: '1.0.0' });
    expect(await upToDate.updates.infoFor(socket)).toMatchObject({ latest: '1.0.0', updateAvailable: false });
    const offline = setup({ latest: null });
    expect(await offline.updates.infoFor(socket)).toMatchObject({ latest: null, updateAvailable: false });
  });

  it('refresh forces a fresh release lookup, and is harmless without an update service', async () => {
    const getLatestVersion = vi.fn(async (_options?: { force?: boolean }) => '1.6.1');
    const service: UpdateService = {
      currentVersion: '1.0.0',
      canSelfUpdate: true,
      getLatestVersion,
      startUpdate: vi.fn(async () => {}),
    };
    const updates = createDashboardUpdates(service, { isLoopback: () => true, isPasswordVerified: () => true });
    await updates.refresh();
    expect(getLatestVersion).toHaveBeenCalledWith({ force: true });
    const none = createDashboardUpdates(undefined, { isLoopback: () => true, isPasswordVerified: () => true });
    await expect(none.refresh()).resolves.toBeUndefined();
  });

  it('does not offer the button to an anonymous non-loopback client', async () => {
    const { updates, startUpdate } = setup();
    expect(await updates.infoFor(socket)).toMatchObject({ canUpdate: false });
    expect(await updates.start(socket)).toMatchObject({ type: 'updateStatus', state: 'rejected' });
    expect(startUpdate).not.toHaveBeenCalled();
  });

  it('allows a password-authenticated remote client', async () => {
    const { updates, startUpdate } = setup({ verified: true });
    expect(await updates.start(socket)).toEqual({ type: 'updateStatus', state: 'started' });
    expect(startUpdate).toHaveBeenCalledTimes(1);
  });

  it('refuses installs that cannot update themselves even from loopback', async () => {
    const { updates, startUpdate } = setup({ loopback: true, canSelfUpdate: false });
    expect(await updates.infoFor(socket)).toMatchObject({ canUpdate: false });
    expect(await updates.start(socket)).toMatchObject({ state: 'rejected' });
    expect(startUpdate).not.toHaveBeenCalled();
  });

  it('debounces repeated starts, then allows another after the window', async () => {
    const { updates, startUpdate, advance } = setup({ loopback: true });
    expect(await updates.start(socket)).toMatchObject({ state: 'started' });
    expect(await updates.start(socket)).toMatchObject({ state: 'rejected' });
    advance(3 * 60 * 1000);
    expect(await updates.start(socket)).toMatchObject({ state: 'started' });
    expect(startUpdate).toHaveBeenCalledTimes(2);
  });

  it('launches only one updater when two sockets start at the same time', async () => {
    const { updates, startUpdate } = setup({ loopback: true });
    const [a, b] = await Promise.all([updates.start(socket), updates.start(socket)]);
    expect([a, b].filter((r) => r.type === 'updateStatus' && r.state === 'started')).toHaveLength(1);
    expect(startUpdate).toHaveBeenCalledTimes(1);
  });

  it('reports an updater that exits without restarting us, and lets the user retry at once', async () => {
    const { updates, startUpdate, onFailed } = setup({ loopback: true });
    await updates.start(socket);
    startUpdate.mock.calls[0]?.[0](1);
    expect(onFailed).toHaveBeenCalledWith(expect.stringContaining('code 1'));
    expect(await updates.start(socket)).toMatchObject({ state: 'started' });
  });

  it('reports a spawn failure without arming the debounce', async () => {
    const { updates, startUpdate } = setup({ loopback: true });
    startUpdate.mockRejectedValueOnce(new Error('spawn failed'));
    expect(await updates.start(socket)).toEqual({ type: 'updateStatus', state: 'failed', message: 'spawn failed' });
    expect(await updates.start(socket)).toMatchObject({ state: 'started' });
  });
});
