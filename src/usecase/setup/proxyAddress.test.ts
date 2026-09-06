import { describe, expect, it } from 'vitest';
import { ProxyHostUnresolvedError, resolveProxyHost } from './proxyAddress';

describe('resolveProxyHost', () => {
  it('uses localhost for a target that is this machine', () => {
    expect(resolveProxyHost({ target: 'mac', detectedLanAddresses: [] })).toBe('localhost');
    expect(resolveProxyHost({ target: 'linux', detectedLanAddresses: ['203.0.113.5'] })).toBe('localhost');
  });

  it('uses the detected LAN address for a separate device target', () => {
    expect(resolveProxyHost({ target: 'android', detectedLanAddresses: ['203.0.113.5', '203.0.113.10'] })).toBe(
      '203.0.113.5',
    );
  });

  it('throws when a device target has no detected LAN address and no override', () => {
    expect(() => resolveProxyHost({ target: 'android', detectedLanAddresses: [] })).toThrow(ProxyHostUnresolvedError);
    expect(() => resolveProxyHost({ target: 'ios', detectedLanAddresses: [] })).toThrow(ProxyHostUnresolvedError);
  });

  it('an explicit --host override always wins, even for a same-machine target', () => {
    expect(resolveProxyHost({ target: 'mac', hostOverride: '203.0.113.9', detectedLanAddresses: [] })).toBe(
      '203.0.113.9',
    );
    expect(
      resolveProxyHost({ target: 'android', hostOverride: '203.0.113.9', detectedLanAddresses: ['203.0.113.5'] }),
    ).toBe('203.0.113.9');
  });
});
