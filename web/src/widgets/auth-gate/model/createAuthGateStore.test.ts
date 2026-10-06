import { describe, expect, it } from 'vitest';
import { fakeDashboardConnection } from '@/shared/api';
import { createAuthGateStore } from './createAuthGateStore';

describe('createAuthGateStore (issue #66)', () => {
  it('starts unknown before any message arrives', () => {
    const fake = fakeDashboardConnection();
    const store = createAuthGateStore(fake.connection);
    expect(store.getState().status).toBe('unknown');
  });

  it('locks on authRequired', () => {
    const fake = fakeDashboardConnection();
    const store = createAuthGateStore(fake.connection);
    fake.emit({ type: 'authRequired' });
    expect(store.getState().status).toBe('locked');
    expect(store.getState().error).toBeUndefined();
  });

  it('stays locked with an error on authFailed', () => {
    const fake = fakeDashboardConnection();
    const store = createAuthGateStore(fake.connection);
    fake.emit({ type: 'authRequired' });
    fake.emit({ type: 'authFailed' });
    expect(store.getState().status).toBe('locked');
    expect(store.getState().error).toBe('Incorrect password');
  });

  it('unlocks on any other message type (no password required)', () => {
    const fake = fakeDashboardConnection();
    const store = createAuthGateStore(fake.connection);
    fake.emit({ type: 'backlog', items: [] });
    expect(store.getState().status).toBe('unlocked');
  });

  it('unlocks after a locked socket receives the post-login snapshot', () => {
    const fake = fakeDashboardConnection();
    const store = createAuthGateStore(fake.connection);
    fake.emit({ type: 'authRequired' });
    fake.emit({ type: 'backlog', items: [] });
    expect(store.getState().status).toBe('unlocked');
    expect(store.getState().error).toBeUndefined();
  });

  it('login sends a login command with the given password', () => {
    const fake = fakeDashboardConnection();
    const store = createAuthGateStore(fake.connection);
    store.getState().login('hunter2');
    expect(fake.sent).toEqual([{ type: 'login', password: 'hunter2' }]);
  });

  describe('what the server asked for (issue #205)', () => {
    it('is a password until told otherwise, including for an older server whose authRequired has no method', () => {
      const fake = fakeDashboardConnection();
      const store = createAuthGateStore(fake.connection);
      expect(store.getState().method).toBe('password');
      fake.emit({ type: 'authRequired' });
      expect(store.getState().method).toBe('password');
    });

    it('reads the access-token method from authRequired', () => {
      const fake = fakeDashboardConnection();
      const store = createAuthGateStore(fake.connection);
      fake.emit({ type: 'authRequired', method: 'token' });
      expect(store.getState()).toMatchObject({ status: 'locked', method: 'token' });
    });
  });
});
