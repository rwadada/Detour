import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDashboardConnection } from '@/shared/api';
import { createAdbReverseStore } from './createAdbReverseStore';

const state = (overrides = {}) => ({
  type: 'adbReverseState' as const,
  enabled: false,
  usbDevices: 0,
  port: 8080,
  canChange: true,
  ...overrides,
});

describe('createAdbReverseStore', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('has nothing until the server sends adbReverseState (a server without the switch never does)', () => {
    const fake = fakeDashboardConnection();
    const store = createAdbReverseStore(fake.connection);
    expect(store.getState().info).toBeNull();
    expect(store.getState().pending).toBe(false);
  });

  it('mirrors adbReverseState', () => {
    const fake = fakeDashboardConnection();
    const store = createAdbReverseStore(fake.connection);
    fake.emit(state({ enabled: true, usbDevices: 2 }));
    expect(store.getState().info).toEqual({ enabled: true, usbDevices: 2, port: 8080, canChange: true });
  });

  it('sends setAdbReverse and leaves the switch where the server says it is until the server answers', () => {
    const fake = fakeDashboardConnection();
    const store = createAdbReverseStore(fake.connection);
    fake.emit(state());

    store.getState().setEnabled(true);

    expect(fake.sent).toContainEqual({ type: 'setAdbReverse', enabled: true });
    expect(store.getState().pending).toBe(true);
    expect(store.getState().info?.enabled).toBe(false); // no optimistic flip

    fake.emit(state({ enabled: true }));
    expect(store.getState().pending).toBe(false);
    expect(store.getState().info?.enabled).toBe(true);
  });

  it("shows the server's answer even when the server refused (the switch snaps back)", () => {
    const fake = fakeDashboardConnection();
    const store = createAdbReverseStore(fake.connection);
    fake.emit(state());
    store.getState().setEnabled(true);
    fake.emit(state({ enabled: false })); // refused: state unchanged
    expect(store.getState().info?.enabled).toBe(false);
    expect(store.getState().pending).toBe(false);
  });

  it('sends nothing for a client that may not change it', () => {
    const fake = fakeDashboardConnection();
    const store = createAdbReverseStore(fake.connection);
    fake.emit(state({ canChange: false }));
    store.getState().setEnabled(true);
    expect(fake.sent).toEqual([]);
    expect(store.getState().pending).toBe(false);
  });

  it('sends nothing before the first state has arrived', () => {
    const fake = fakeDashboardConnection();
    const store = createAdbReverseStore(fake.connection);
    store.getState().setEnabled(true);
    expect(fake.sent).toEqual([]);
  });

  it('ignores a second click while one is waiting for its answer', () => {
    const fake = fakeDashboardConnection();
    const store = createAdbReverseStore(fake.connection);
    fake.emit(state());
    store.getState().setEnabled(true);
    store.getState().setEnabled(false);
    expect(fake.sent).toHaveLength(1);
  });

  it('becomes usable again if the server never answers', () => {
    const fake = fakeDashboardConnection();
    const store = createAdbReverseStore(fake.connection, { pendingTimeoutMs: 1000 });
    fake.emit(state());
    store.getState().setEnabled(true);
    vi.advanceTimersByTime(1000);
    expect(store.getState().pending).toBe(false);
  });

  it('follows the USB device count as it changes', () => {
    const fake = fakeDashboardConnection();
    const store = createAdbReverseStore(fake.connection);
    fake.emit(state({ enabled: true, usbDevices: 0 }));
    fake.emit(state({ enabled: true, usbDevices: 1 }));
    expect(store.getState().info?.usbDevices).toBe(1);
  });
});
