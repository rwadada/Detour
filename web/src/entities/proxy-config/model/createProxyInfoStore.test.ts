import { describe, expect, it } from 'vitest';
import { fakeDashboardConnection, PROTOCOL_VERSION } from '@/shared/api';
import { createProxyInfoStore, isProtocolMismatch } from './createProxyInfoStore';

describe('createProxyInfoStore', () => {
  it('starts with proxyPort null before any message arrives', () => {
    const fake = fakeDashboardConnection();
    const store = createProxyInfoStore(fake.connection);
    expect(store.getState().proxyPort).toBeNull();
  });

  it('sets proxyPort on a proxyInfo message', () => {
    const fake = fakeDashboardConnection();
    const store = createProxyInfoStore(fake.connection);
    fake.emit({ type: 'proxyInfo', proxyPort: 8080, insecureUpstream: false });
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

  it('falls back to true for dashboardOnLan when an older server omits that field but still sent addresses (its old all-or-nothing semantics)', () => {
    const fake = fakeDashboardConnection();
    const store = createProxyInfoStore(fake.connection);
    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- a private-range test fixture address, not a real one.
    fake.emit({ type: 'lanInfo', addresses: ['192.168.1.5'] });
    expect(store.getState().dashboardOnLan).toBe(true);
  });

  it('falls back to false for dashboardOnLan when an older server omits that field and sent no addresses either', () => {
    const fake = fakeDashboardConnection();
    const store = createProxyInfoStore(fake.connection);
    fake.emit({ type: 'lanInfo', addresses: [] });
    expect(store.getState().dashboardOnLan).toBe(false);
  });

  it('starts with insecureUpstream false before any message arrives', () => {
    const fake = fakeDashboardConnection();
    const store = createProxyInfoStore(fake.connection);
    expect(store.getState().insecureUpstream).toBe(false);
  });

  it('sets insecureUpstream: true from a proxyInfo message (issue #160)', () => {
    const fake = fakeDashboardConnection();
    const store = createProxyInfoStore(fake.connection);
    fake.emit({ type: 'proxyInfo', proxyPort: 8080, insecureUpstream: true });
    expect(store.getState().insecureUpstream).toBe(true);
  });

  it('falls back to insecureUpstream: false for an older server that predates the field', () => {
    const fake = fakeDashboardConnection();
    const store = createProxyInfoStore(fake.connection);
    fake.emit({ type: 'proxyInfo', proxyPort: 8080 });
    expect(store.getState().insecureUpstream).toBe(false);
  });

  describe('protocol version (issue #209)', () => {
    it('is not a mismatch before proxyInfo has arrived', () => {
      const store = createProxyInfoStore(fakeDashboardConnection().connection);
      expect(isProtocolMismatch(store.getState())).toBe(false);
    });

    it("is not a mismatch when the server reports this page's own version", () => {
      const fake = fakeDashboardConnection();
      const store = createProxyInfoStore(fake.connection);
      fake.emit({ type: 'proxyInfo', proxyPort: 8080, protocolVersion: PROTOCOL_VERSION });
      expect(store.getState().serverProtocolVersion).toBe(PROTOCOL_VERSION);
      expect(isProtocolMismatch(store.getState())).toBe(false);
    });

    it('is a mismatch when the server reports a different version', () => {
      const fake = fakeDashboardConnection();
      const store = createProxyInfoStore(fake.connection);
      fake.emit({ type: 'proxyInfo', proxyPort: 8080, protocolVersion: PROTOCOL_VERSION + 1 });
      expect(isProtocolMismatch(store.getState())).toBe(true);
    });

    it('treats a server that sends no version at all as a mismatch (it predates the check)', () => {
      const fake = fakeDashboardConnection();
      const store = createProxyInfoStore(fake.connection);
      fake.emit({ type: 'proxyInfo', proxyPort: 8080 });
      expect(store.getState().serverProtocolVersion).toBeNull();
      expect(isProtocolMismatch(store.getState())).toBe(true);
    });
  });
});
