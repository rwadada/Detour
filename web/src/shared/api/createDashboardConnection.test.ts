import { describe, expect, it, vi } from 'vitest';
import { createDashboardConnection } from './createDashboardConnection';
import type { DashboardConnector, DashboardSocketHandlers } from './ws';

/** A fake `DashboardConnector` that captures the handlers it's given, so a test can drive them by hand. */
function fakeConnector() {
  const sendSpy = vi.fn();
  let handlers: DashboardSocketHandlers | undefined;
  const connect: DashboardConnector = (h) => {
    handlers = h;
    return { close: vi.fn(), send: sendSpy };
  };
  return {
    connect,
    sendSpy,
    emit: (message: Parameters<DashboardSocketHandlers['onMessage']>[0]) => handlers?.onMessage(message),
    setStatus: (status: Parameters<DashboardSocketHandlers['onStatusChange']>[0]) => handlers?.onStatusChange(status),
  };
}

describe('createDashboardConnection', () => {
  it('fans a message out to every subscribed listener', () => {
    const fake = fakeConnector();
    const connection = createDashboardConnection(fake.connect);
    const a = vi.fn();
    const b = vi.fn();
    connection.onMessage(a);
    connection.onMessage(b);

    fake.emit({ type: 'intercept', state: { enabled: false } });

    expect(a).toHaveBeenCalledWith({ type: 'intercept', state: { enabled: false } });
    expect(b).toHaveBeenCalledWith({ type: 'intercept', state: { enabled: false } });
  });

  it('stops notifying a listener once unsubscribed', () => {
    const fake = fakeConnector();
    const connection = createDashboardConnection(fake.connect);
    const listener = vi.fn();
    const unsubscribe = connection.onMessage(listener);

    unsubscribe();
    fake.emit({ type: 'intercept', state: { enabled: false } });

    expect(listener).not.toHaveBeenCalled();
  });

  it('tracks status, calling a newly-subscribed listener immediately with the current value', () => {
    const fake = fakeConnector();
    const connection = createDashboardConnection(fake.connect);
    expect(connection.getStatus()).toBe('connecting');

    fake.setStatus('open');
    expect(connection.getStatus()).toBe('open');

    const listener = vi.fn();
    connection.onStatusChange(listener);
    expect(listener).toHaveBeenCalledWith('open');

    fake.setStatus('closed');
    expect(listener).toHaveBeenCalledWith('closed');
    expect(connection.getStatus()).toBe('closed');
  });

  it('forwards send() to the underlying socket', () => {
    const fake = fakeConnector();
    const connection = createDashboardConnection(fake.connect);
    connection.send({ type: 'setIntercept', enabled: true });
    expect(fake.sendSpy).toHaveBeenCalledWith({ type: 'setIntercept', enabled: true });
  });
});
