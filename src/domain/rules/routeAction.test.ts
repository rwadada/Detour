import { describe, expect, it } from 'vitest';
import { computeRouteTarget } from './routeAction';

describe('computeRouteTarget', () => {
  it('redirects host/port while preserving the Host header by default', () => {
    const target = computeRouteTarget(
      { type: 'route', host: 'staging.example.com', port: 8443 },
      { port: 443, isSSL: true },
    );
    expect(target.host).toBe('staging.example.com');
    expect(target.port).toBe(8443);
    expect(target.hostHeader).toBeUndefined();
  });

  it('rewrites the Host header when preserveHostHeader is false', () => {
    const target = computeRouteTarget(
      { type: 'route', host: 'staging.example.com', preserveHostHeader: false },
      { port: 443, isSSL: true },
    );
    // No explicit `port` in the action: falls back to the original port, and
    // since it equals the default HTTPS port, no `:port` suffix is added.
    expect(target.hostHeader).toBe('staging.example.com');
  });

  it('appends a non-default port to the rewritten Host header', () => {
    const target = computeRouteTarget(
      { type: 'route', host: 'staging.example.com', port: 8080, preserveHostHeader: false },
      { port: 80, isSSL: false },
    );
    expect(target.hostHeader).toBe('staging.example.com:8080');
  });
});
