import { describe, expect, it, vi } from 'vitest';
import { createUpdateService } from './updateService';

function setup(fetchLatestVersion: () => Promise<string>) {
  let clock = 1_000;
  const startUpdater = vi.fn(async () => {});
  const service = createUpdateService({
    currentVersion: '1.0.0',
    canSelfUpdate: true,
    fetchLatestVersion,
    startUpdater,
    now: () => clock,
  });
  return { service, startUpdater, advance: (ms: number) => (clock += ms) };
}

describe('createUpdateService', () => {
  it('caches a successful lookup for hours', async () => {
    const fetch = vi.fn(async () => '1.6.1');
    const { service, advance } = setup(fetch);
    expect(await service.getLatestVersion()).toBe('1.6.1');
    advance(60 * 60 * 1000);
    expect(await service.getLatestVersion()).toBe('1.6.1');
    expect(fetch).toHaveBeenCalledTimes(1);
    advance(6 * 60 * 60 * 1000);
    await service.getLatestVersion();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('returns null on failure and retries only after a short backoff', async () => {
    const fetch = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('1.6.1');
    const { service, advance } = setup(fetch);
    expect(await service.getLatestVersion()).toBeNull();
    advance(60 * 1000);
    expect(await service.getLatestVersion()).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    advance(10 * 60 * 1000);
    expect(await service.getLatestVersion()).toBe('1.6.1');
  });

  it('lets a forced check skip the cache once the last lookup is a little old', async () => {
    const fetch = vi.fn<() => Promise<string>>().mockResolvedValueOnce('1.0.0').mockResolvedValue('1.6.1');
    const { service, advance } = setup(fetch);
    expect(await service.getLatestVersion()).toBe('1.0.0');
    advance(60 * 1000);
    expect(await service.getLatestVersion()).toBe('1.0.0');
    expect(await service.getLatestVersion({ force: true })).toBe('1.6.1');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('retries a failed lookup on a forced check instead of waiting out the backoff', async () => {
    const fetch = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('1.6.1');
    const { service, advance } = setup(fetch);
    expect(await service.getLatestVersion()).toBeNull();
    advance(60 * 1000);
    expect(await service.getLatestVersion({ force: true })).toBe('1.6.1');
  });

  it('rate limits forced checks so repeated clicks reuse the last lookup', async () => {
    const fetch = vi.fn(async () => '1.6.1');
    const { service, advance } = setup(fetch);
    await service.getLatestVersion({ force: true });
    advance(5 * 1000);
    await service.getLatestVersion({ force: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    advance(30 * 1000);
    await service.getLatestVersion({ force: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight lookup between concurrent callers', async () => {
    const fetch = vi.fn(async () => '1.6.1');
    const { service } = setup(fetch);
    await Promise.all([service.getLatestVersion(), service.getLatestVersion()]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('delegates startUpdate and exposes the static fields', async () => {
    const { service, startUpdater } = setup(async () => '1.6.1');
    const onExit = vi.fn();
    await service.startUpdate(onExit);
    expect(startUpdater).toHaveBeenCalledWith(onExit);
    expect(service.currentVersion).toBe('1.0.0');
    expect(service.canSelfUpdate).toBe(true);
  });
});
