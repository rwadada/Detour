import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDashboardConnection } from '@/shared/api';
import { createUpdateStore } from './createUpdateStore';

const info = (current: string, overrides = {}) => ({
  type: 'updateInfo' as const,
  current,
  latest: '1.6.1',
  updateAvailable: true,
  canUpdate: true,
  ...overrides,
});

describe('createUpdateStore', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('mirrors updateInfo', () => {
    const fake = fakeDashboardConnection();
    const store = createUpdateStore(fake.connection, { reload: vi.fn() });
    expect(store.getState().info).toBeNull();
    fake.emit(info('1.0.0'));
    expect(store.getState().info).toEqual({
      current: '1.0.0',
      latest: '1.6.1',
      updateAvailable: true,
      canUpdate: true,
    });
  });

  it('sends startUpdate once and ignores further clicks while updating', () => {
    const fake = fakeDashboardConnection();
    const store = createUpdateStore(fake.connection, { reload: vi.fn() });
    fake.emit(info('1.0.0'));
    store.getState().startUpdate();
    store.getState().startUpdate();
    expect(fake.sent).toEqual([{ type: 'startUpdate' }]);
    expect(store.getState().phase).toBe('updating');
  });

  it('reloads once the reconnected server reports a different version', () => {
    const reload = vi.fn();
    const fake = fakeDashboardConnection();
    const store = createUpdateStore(fake.connection, { reload });
    fake.emit(info('1.0.0'));
    store.getState().startUpdate();
    fake.emit({ type: 'updateStatus', state: 'started' });
    fake.emit(info('1.0.0')); // a reconnect to the still-old server must not reload
    expect(reload).not.toHaveBeenCalled();
    fake.emit(info('1.6.1', { updateAvailable: false }));
    expect(reload).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(store.getState().phase).toBe('updating');
  });

  it('does not reload on a version change the user did not ask for', () => {
    const reload = vi.fn();
    const fake = fakeDashboardConnection();
    createUpdateStore(fake.connection, { reload });
    fake.emit(info('1.0.0'));
    fake.emit(info('1.6.1'));
    expect(reload).not.toHaveBeenCalled();
  });

  it('shows the server message when the update is rejected or fails', () => {
    const fake = fakeDashboardConnection();
    const store = createUpdateStore(fake.connection, { reload: vi.fn() });
    store.getState().startUpdate();
    fake.emit({ type: 'updateStatus', state: 'rejected', message: 'not allowed' });
    expect(store.getState()).toMatchObject({ phase: 'failed', message: 'not allowed' });
  });

  it('gives up after the timeout and lets the user retry', () => {
    const fake = fakeDashboardConnection();
    const store = createUpdateStore(fake.connection, { reload: vi.fn(), timeoutMs: 1000 });
    store.getState().startUpdate();
    vi.advanceTimersByTime(1000);
    expect(store.getState().phase).toBe('failed');
    store.getState().startUpdate();
    expect(store.getState().phase).toBe('updating');
    expect(fake.sent).toHaveLength(2);
  });

  it('Later after a failure clears the failed state so the banner can hide', () => {
    const fake = fakeDashboardConnection();
    const store = createUpdateStore(fake.connection, { reload: vi.fn() });
    fake.emit(info('1.0.0'));
    store.getState().startUpdate();
    fake.emit({ type: 'updateStatus', state: 'failed', message: 'brew failed' });
    store.getState().dismiss();
    expect(store.getState()).toMatchObject({ phase: 'idle', message: undefined, dismissedVersion: '1.6.1' });
  });

  it('an updater failure broadcast to a tab that is not updating is ignored', () => {
    const fake = fakeDashboardConnection();
    const store = createUpdateStore(fake.connection, { reload: vi.fn() });
    fake.emit(info('1.0.0'));
    fake.emit({ type: 'updateStatus', state: 'failed', message: 'updater exited' });
    expect(store.getState().phase).toBe('idle');
  });

  it('dismiss hides only the current latest release', () => {
    const fake = fakeDashboardConnection();
    const store = createUpdateStore(fake.connection, { reload: vi.fn() });
    fake.emit(info('1.0.0'));
    store.getState().dismiss();
    expect(store.getState().dismissedVersion).toBe('1.6.1');
  });

  describe('checkForUpdate', () => {
    it('sends checkUpdate once and settles on the next updateInfo', () => {
      const fake = fakeDashboardConnection();
      const store = createUpdateStore(fake.connection, { reload: vi.fn() });
      fake.emit(info('1.0.0'));
      store.getState().checkForUpdate();
      store.getState().checkForUpdate();
      expect(fake.sent).toEqual([{ type: 'checkUpdate' }]);
      expect(store.getState().checkState).toBe('checking');
      fake.emit(info('1.0.0', { latest: '1.0.0', updateAvailable: false }));
      expect(store.getState().checkState).toBe('checked');
      vi.advanceTimersByTime(60 * 1000);
      expect(store.getState().checkState).toBe('checked');
    });

    it('gives up when the server never answers', () => {
      const fake = fakeDashboardConnection();
      const store = createUpdateStore(fake.connection, { reload: vi.fn(), checkTimeoutMs: 1000 });
      fake.emit(info('1.0.0'));
      store.getState().checkForUpdate();
      vi.advanceTimersByTime(1000);
      expect(store.getState().checkState).toBe('timeout');
      store.getState().checkForUpdate();
      expect(store.getState().checkState).toBe('checking');
      expect(fake.sent).toHaveLength(2);
    });

    it('does not mistake an unrequested updateInfo for a check result', () => {
      const fake = fakeDashboardConnection();
      const store = createUpdateStore(fake.connection, { reload: vi.fn() });
      fake.emit(info('1.0.0'));
      expect(store.getState().checkState).toBe('idle');
    });

    it('lets a release hidden with "Later" resurface', () => {
      const fake = fakeDashboardConnection();
      const store = createUpdateStore(fake.connection, { reload: vi.fn() });
      fake.emit(info('1.0.0'));
      store.getState().dismiss();
      store.getState().checkForUpdate();
      expect(store.getState().dismissedVersion).toBeNull();
    });
  });
});
