import { describe, expect, it } from 'vitest';
import { fakeDashboardConnection } from '@/shared/api';
import { createFocusStore } from './createFocusStore';

describe('createFocusStore', () => {
  it('defaults to an empty (unrestricted) allowlist', () => {
    const fake = fakeDashboardConnection();
    const store = createFocusStore(fake.connection);
    expect(store.getState().focusHosts).toEqual([]);
  });

  it('mirrors the server-pushed allowlist', () => {
    const fake = fakeDashboardConnection();
    const store = createFocusStore(fake.connection);
    fake.emit({ type: 'focus', state: { hosts: ['a.com', 'b.com'] } });
    expect(store.getState().focusHosts).toEqual(['a.com', 'b.com']);
  });

  it('setFocus sends a setFocus command', () => {
    const fake = fakeDashboardConnection();
    const store = createFocusStore(fake.connection);
    store.getState().setFocus(['a.com']);
    expect(fake.sent).toEqual([{ type: 'setFocus', hosts: ['a.com'] }]);
  });
});
