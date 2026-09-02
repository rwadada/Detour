import { describe, expect, it } from 'vitest';
import { fakeDashboardConnection } from '@/shared/api';
import { createInterceptStore } from './createInterceptStore';

describe('createInterceptStore', () => {
  it('defaults to enabled until the server says otherwise', () => {
    const fake = fakeDashboardConnection();
    const store = createInterceptStore(fake.connection);
    expect(store.getState().interceptEnabled).toBe(true);
  });

  it('mirrors the server-pushed intercept state', () => {
    const fake = fakeDashboardConnection();
    const store = createInterceptStore(fake.connection);
    fake.emit({ type: 'intercept', state: { enabled: false } });
    expect(store.getState().interceptEnabled).toBe(false);
  });

  it('setIntercept sends a setIntercept command', () => {
    const fake = fakeDashboardConnection();
    const store = createInterceptStore(fake.connection);
    store.getState().setIntercept(false);
    expect(fake.sent).toEqual([{ type: 'setIntercept', enabled: false }]);
  });
});
