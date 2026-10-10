import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { AdbReverseWatcher } from '../adb/adbReverseWatcher';
import { createDashboardAdbReverse } from './dashboardAdbReverse';

const verified = {} as WebSocket;
const stranger = {} as WebSocket;
const trust = { isVerified: (socket: WebSocket) => socket === verified };

function fakeWatcher(usb = 0) {
  const watcher = {
    stop: vi.fn(),
    isRunning: () => true,
    connectedUsbDevices: () => usb,
  } satisfies AdbReverseWatcher;
  return watcher;
}

function setup(options: { enabledAtStart?: boolean; usb?: number } = {}) {
  const watchers: ReturnType<typeof fakeWatcher>[] = [];
  const startWatcher = vi.fn(() => {
    const w = fakeWatcher(options.usb ?? 0);
    watchers.push(w);
    return w;
  });
  const onChange = vi.fn();
  const controller = createDashboardAdbReverse({
    port: 8080,
    startWatcher,
    enabledAtStart: options.enabledAtStart,
    trust,
    onChange,
  });
  return { controller, startWatcher, watchers, onChange };
}

describe('createDashboardAdbReverse', () => {
  it('is off until asked, and starts nothing on its own', () => {
    const { controller, startWatcher } = setup();
    expect(startWatcher).not.toHaveBeenCalled();
    expect(controller.stateFor(verified)).toMatchObject({
      type: 'adbReverseState',
      enabled: false,
      usbDevices: 0,
      port: 8080,
    });
  });

  it('starts the watcher at begin() when it was asked to be on from the start — and not before', () => {
    const { controller, startWatcher } = setup({ enabledAtStart: true });
    expect(startWatcher).not.toHaveBeenCalled(); // the server may still fail to come up
    controller.begin();
    expect(startWatcher).toHaveBeenCalledTimes(1);
    expect(controller.stateFor(verified)).toMatchObject({ enabled: true });
    controller.begin(); // idempotent
    expect(startWatcher).toHaveBeenCalledTimes(1);
  });

  it('does not start a watcher at begin() when it was not asked to', () => {
    const { controller, startWatcher } = setup();
    controller.begin();
    expect(startWatcher).not.toHaveBeenCalled();
  });

  it('turns on and off for a socket that proved the password or token, telling everyone each time', () => {
    const { controller, startWatcher, watchers, onChange } = setup();

    expect(controller.setEnabled(verified, true)).toBe(true);
    expect(startWatcher).toHaveBeenCalledTimes(1);
    expect(controller.stateFor(verified).type === 'adbReverseState' && controller.stateFor(verified)).toMatchObject({
      enabled: true,
    });
    expect(onChange).toHaveBeenCalledTimes(1);

    expect(controller.setEnabled(verified, false)).toBe(true);
    expect(watchers[0]!.stop).toHaveBeenCalledTimes(1);
    expect(controller.stateFor(verified)).toMatchObject({ enabled: false });
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('refuses a socket that was merely let in: nothing is started or stopped, and nobody is told anything', () => {
    const { controller, startWatcher, onChange } = setup();
    expect(controller.setEnabled(stranger, true)).toBe(false);
    expect(startWatcher).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();

    controller.setEnabled(verified, true);
    onChange.mockClear();
    expect(controller.setEnabled(stranger, false)).toBe(false);
    expect(controller.stateFor(verified)).toMatchObject({ enabled: true });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('says per socket whether it may change the switch', () => {
    const { controller } = setup();
    expect(controller.stateFor(verified)).toMatchObject({ canChange: true });
    expect(controller.stateFor(stranger)).toMatchObject({ canChange: false });
  });

  it('does not start a second watcher when turned on twice, nor announce a change that did not happen', () => {
    const { controller, startWatcher, onChange } = setup();
    controller.setEnabled(verified, true);
    controller.setEnabled(verified, true);
    expect(startWatcher).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);

    controller.setEnabled(verified, false);
    controller.setEnabled(verified, false);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('reports the USB devices the watcher sees', () => {
    const { controller } = setup({ usb: 2 });
    controller.setEnabled(verified, true);
    expect(controller.stateFor(verified)).toMatchObject({ enabled: true, usbDevices: 2 });
  });

  it('stop() ends whichever watcher is running (process shutdown), and is safe with none', () => {
    const { controller, watchers } = setup();
    expect(() => controller.stop()).not.toThrow();
    controller.setEnabled(verified, true);
    controller.stop();
    expect(watchers[0]!.stop).toHaveBeenCalledTimes(1);
    expect(controller.stateFor(verified)).toMatchObject({ enabled: false });
  });
});
