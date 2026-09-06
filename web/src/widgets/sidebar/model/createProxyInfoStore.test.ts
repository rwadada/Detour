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

  it('starts with an empty lanAddresses list before any message arrives', () => {
    const fake = fakeDashboardConnection();
    const store = createProxyInfoStore(fake.connection);
    expect(store.getState().lanAddresses).toEqual([]);
  });

  it('sets lanAddresses on a lanInfo message', () => {
    const fake = fakeDashboardConnection();
    const store = createProxyInfoStore(fake.connection);
    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- a private-range test fixture address, not a real one.
    const fakeAddresses = ['192.168.1.5'];
    fake.emit({ type: 'lanInfo', addresses: fakeAddresses, dashboardOnLan: false });
    expect(store.getState().lanAddresses).toEqual(fakeAddresses);
  });

  it('starts with dashboardOnLan false before any message arrives', () => {
    const fake = fakeDashboardConnection();
    const store = createProxyInfoStore(fake.connection);
    expect(store.getState().dashboardOnLan).toBe(false);
  });

  it("sets dashboardOnLan from a lanInfo message's own field, independent of addresses", () => {
    const fake = fakeDashboardConnection();
    const store = createProxyInfoStore(fake.connection);
    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- a private-range test fixture address, not a real one.
    fake.emit({ type: 'lanInfo', addresses: ['192.168.1.5'], dashboardOnLan: true });
    expect(store.getState().dashboardOnLan).toBe(true);
  });
});
