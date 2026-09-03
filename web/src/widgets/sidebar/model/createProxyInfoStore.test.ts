import { describe, expect, it } from 'vitest';
import { fakeDashboardConnection } from '@/shared/api';
import { createProxyInfoStore } from './createProxyInfoStore';

describe('createProxyInfoStore', () => {
  it('starts with proxyPort null before any message arrives', () => {
    const fake = fakeDashboardConnection();
    const store = createProxyInfoStore(fake.connection);
    expect(store.getState().proxyPort).toBeNull();
  });

  it('sets proxyPort on a proxyInfo message', () => {
    const fake = fakeDashboardConnection();
    const store = createProxyInfoStore(fake.connection);
    fake.emit({ type: 'proxyInfo', proxyPort: 8080 });
    expect(store.getState().proxyPort).toBe(8080);
  });

  it('ignores unrelated message types', () => {
    const fake = fakeDashboardConnection();
    const store = createProxyInfoStore(fake.connection);
    fake.emit({ type: 'intercept', state: { enabled: false } });
    expect(store.getState().proxyPort).toBeNull();
  });
});
