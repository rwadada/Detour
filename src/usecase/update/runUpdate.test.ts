import { describe, expect, it, vi } from 'vitest';
import type { RunState } from '../../domain/daemon/types';
import { runUpdate, type UpdateDeps } from './runUpdate';

function instance(port: number, overrides: Partial<RunState> = {}): RunState {
  return {
    pid: 1000 + port,
    requestedPort: port,
    proxyPort: port,
    dashboardPort: port + 1000,
    headless: false,
    detached: true,
    startedAt: 0,
    startArgs: ['--port', String(port)],
    cwd: '/work',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<UpdateDeps> = {}): UpdateDeps & { calls: string[] } {
  const calls: string[] = [];
  const deps: UpdateDeps = {
    currentVersion: '1.6.0',
    canSelfUpgrade: true,
    manualUpgradeHint: 'upgrade by hand',
    fetchLatestVersion: async () => '1.7.0',
    listRunningInstances: () => [],
    upgradePackage: async () => void calls.push('upgrade'),
    readInstalledVersion: async () => '1.7.0',
    stopInstance: async (state) => void calls.push(`stop:${state.requestedPort}`),
    startInstance: async (state) => void calls.push(`start:${state.requestedPort}`),
    confirm: async () => true,
    log: () => undefined,
    warn: () => undefined,
    ...overrides,
  };
  return Object.assign(deps, { calls });
}

describe('runUpdate', () => {
  it('does nothing when already on the latest version', async () => {
    const deps = makeDeps({ fetchLatestVersion: async () => 'v1.6.0' });
    await expect(runUpdate(deps, { checkOnly: false, yes: true })).resolves.toEqual({
      kind: 'up-to-date',
      version: '1.6.0',
    });
    expect(deps.calls).toEqual([]);
  });

  it('--check reports without touching anything, even when self-upgrade is unsupported', async () => {
    const deps = makeDeps({ canSelfUpgrade: false, listRunningInstances: () => [instance(8080)] });
    await expect(runUpdate(deps, { checkOnly: true, yes: false })).resolves.toEqual({
      kind: 'update-available',
      current: '1.6.0',
      latest: '1.7.0',
    });
    expect(deps.calls).toEqual([]);
  });

  it('refuses to upgrade an unsupported install with the manual hint', async () => {
    const deps = makeDeps({ canSelfUpgrade: false });
    await expect(runUpdate(deps, { checkOnly: false, yes: true })).rejects.toThrow('upgrade by hand');
  });

  it('upgrades first, then stops and restarts each instance', async () => {
    const deps = makeDeps({ listRunningInstances: () => [instance(8080), instance(9090)] });
    const outcome = await runUpdate(deps, { checkOnly: false, yes: true });
    expect(deps.calls).toEqual(['upgrade', 'stop:8080', 'start:8080', 'stop:9090', 'start:9090']);
    expect(outcome).toMatchObject({ kind: 'updated', from: '1.6.0', to: '1.7.0', restarted: [8080, 9090], failed: [] });
  });

  it('asks for confirmation and stops there when declined', async () => {
    const confirm = vi.fn(async () => false);
    const deps = makeDeps({ confirm, listRunningInstances: () => [instance(8080)] });
    await expect(runUpdate(deps, { checkOnly: false, yes: false })).resolves.toEqual({ kind: 'cancelled' });
    expect(confirm).toHaveBeenCalledOnce();
    expect(deps.calls).toEqual([]);
  });

  it('skips the prompt with --yes', async () => {
    const confirm = vi.fn(async () => false);
    const deps = makeDeps({ confirm });
    await runUpdate(deps, { checkOnly: false, yes: true });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('leaves running instances untouched when the upgrade fails', async () => {
    const deps = makeDeps({
      listRunningInstances: () => [instance(8080)],
      upgradePackage: async () => {
        throw new Error('brew exploded');
      },
    });
    await expect(runUpdate(deps, { checkOnly: false, yes: true })).rejects.toThrow('brew exploded');
    expect(deps.calls).toEqual([]);
  });

  it('does not restart anything when the package manager has not picked up the release yet', async () => {
    const warn = vi.fn();
    const deps = makeDeps({
      warn,
      readInstalledVersion: async () => '1.6.0',
      listRunningInstances: () => [instance(8080)],
    });
    await expect(runUpdate(deps, { checkOnly: false, yes: true })).resolves.toEqual({
      kind: 'formula-lagging',
      current: '1.6.0',
      latest: '1.7.0',
    });
    expect(deps.calls).toEqual(['upgrade']);
    expect(warn).toHaveBeenCalled();
  });

  it('keeps going and reports when one instance fails to restart', async () => {
    const warn = vi.fn();
    const deps = makeDeps({
      warn,
      listRunningInstances: () => [instance(8080), instance(9090)],
      startInstance: async (state) => {
        if (state.requestedPort === 8080) throw new Error('port busy');
      },
    });
    const outcome = await runUpdate(deps, { checkOnly: false, yes: true });
    expect(outcome).toMatchObject({ kind: 'updated', restarted: [9090], failed: [8080] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('port busy'));
  });

  it('does not stop instances started by an older detour (no recorded args) and tells the user', async () => {
    const warn = vi.fn();
    const legacy = instance(8080, { startArgs: undefined, cwd: undefined });
    const deps = makeDeps({ warn, listRunningInstances: () => [legacy] });
    const outcome = await runUpdate(deps, { checkOnly: false, yes: true });
    expect(deps.calls).toEqual(['upgrade']);
    expect(outcome).toMatchObject({ kind: 'updated', restarted: [], notRestartable: [8080] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('detour stop --port 8080'));
  });
});
