import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { printStartupBanner } from './banner';

/**
 * Testable at all only because the banner takes its infra-derived facts as
 * arguments (issue #168) — whether the dashboard SPA is built, the LAN
 * addresses, the already-redacted upstream proxy URL. It used to read all
 * three itself from inside the composition root, where the only way to
 * exercise a branch was to spawn the real CLI.
 */
describe('printStartupBanner', () => {
  const logged: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    logged.push(String(line));
  });

  afterEach(() => {
    logged.length = 0;
    spy.mockClear();
  });

  // Restored, not just cleared: vitest runs several test files per worker
  // process, so a `console.log` left mocked here would silently swallow
  // every other file's output for the rest of that worker's life.
  afterAll(() => {
    spy.mockRestore();
  });

  /** Clears first, so two calls in one test compare two banners rather than one concatenated with the other. */
  function print(overrides: Partial<Parameters<typeof printStartupBanner>[0]> = {}): string {
    logged.length = 0;
    printStartupBanner({
      dashboardHost: 'localhost',
      dashboardTls: false,
      proxyPort: 8080,
      caCertPath: '/home/u/.detour/certs/certs/ca.pem',
      dashboardPort: 9080,
      ruleEngine: undefined,
      dumpDir: undefined,
      http2Enabled: true,
      protoPaths: [],
      dashboardPasswordSet: false,
      // Defaults to authenticated so the pre-existing tests below (which
      // predate issue #158 and don't care about it) don't incidentally trip
      // the new PROXY_OPEN_WARNING — its own tests override this back to
      // `false` explicitly.
      proxyAuthSet: true,
      historyDbPath: undefined,
      upstreamProxyUrl: undefined,
      dashboardBuilt: true,
      lanAddresses: [],
      ...overrides,
    });
    return logged.join('\n');
  }

  it('reports the proxy port and HTTP/2 state', () => {
    expect(print()).toContain('Detour proxy started → http://localhost:8080 (HTTP/2: on)');
    expect(print({ http2Enabled: false })).toContain('HTTP/2: off');
  });

  it('says the dashboard is disabled under --headless rather than printing a URL', () => {
    const output = print({ dashboardPort: undefined });
    expect(output).toContain('Dashboard → disabled (--headless)');
    expect(output).not.toContain('http://localhost:9080');
  });

  it('points an unbuilt dashboard at `npm run build` instead of just its URL', () => {
    expect(print({ dashboardBuilt: false })).toContain('not built yet');
    expect(print({ dashboardBuilt: true })).not.toContain('not built yet');
  });

  it('lists every LAN address for the proxy, and the dashboard only when it is bound there too', () => {
    const localhostOnly = print({ lanAddresses: ['lan-host.local'] });
    expect(localhostOnly).toContain('  Proxy     → http://lan-host.local:8080');
    expect(localhostOnly).not.toContain('  Dashboard → http://lan-host.local:9080');

    const onLan = print({ lanAddresses: ['lan-host.local'], dashboardHost: '0.0.0.0' });
    expect(onLan).toContain('  Dashboard → http://lan-host.local:9080');
  });

  it('uses https:// for the dashboard URL (both localhost and LAN) when dashboardTls is on, http:// when off', () => {
    const http = print({ dashboardTls: false, lanAddresses: ['lan-host.local'], dashboardHost: '0.0.0.0' });
    expect(http).toContain('Dashboard → http://localhost:9080');
    expect(http).toContain('  Dashboard → http://lan-host.local:9080');

    const https = print({ dashboardTls: true, lanAddresses: ['lan-host.local'], dashboardHost: '0.0.0.0' });
    expect(https).toContain('Dashboard → https://localhost:9080');
    expect(https).toContain('  Dashboard → https://lan-host.local:9080');
  });

  it('reports the dashboard transport right after its URL', () => {
    expect(print({ dashboardTls: false })).toContain('Dashboard transport: HTTP (--dashboard-tls on to encrypt)');
    expect(print({ dashboardTls: true })).toContain("Dashboard transport: HTTPS (Detour's CA)");
  });

  it('omits the transport line under --headless, same as the password line', () => {
    expect(print({ dashboardPort: undefined })).not.toContain('Dashboard transport');
  });

  it('warns loudly when the dashboard is bound to every interface', () => {
    expect(print({ dashboardHost: '0.0.0.0' })).toContain('SECURITY');
    expect(print({ dashboardHost: 'localhost' })).not.toContain('SECURITY');
  });

  it('stops claiming there is no authentication once a dashboard password is set', () => {
    const noPassword = print({ dashboardHost: '0.0.0.0', dashboardPasswordSet: false });
    expect(noPassword).toContain('no dashboard password is set');

    const withPassword = print({ dashboardHost: '0.0.0.0', dashboardPasswordSet: true });
    expect(withPassword).toContain('SECURITY');
    expect(withPassword).toContain('the dashboard password is the only thing standing between');
    // The old wording said this even with a password configured, directly
    // contradicting the `Dashboard password: required` line above it.
    expect(withPassword).not.toContain('no dashboard password is set');
  });

  it('omits the dashboard LAN warning for a headless run, which has no dashboard to expose', () => {
    expect(print({ dashboardHost: '0.0.0.0', dashboardPort: undefined })).not.toContain('SECURITY');
  });

  it('reports proxy authentication state right after the startup line', () => {
    expect(print({ proxyAuthSet: false })).toContain('Proxy authentication: off (--proxy-auth <user:pass>)');
    expect(print({ proxyAuthSet: true })).toContain('Proxy authentication: required (Basic)');
  });

  it('warns about an open proxy when bound to the network with no --proxy-auth, even headless', () => {
    const open = print({ dashboardHost: '0.0.0.0', dashboardPort: undefined, proxyAuthSet: false });
    expect(open).toContain('SECURITY');
    expect(open).toContain('the proxy requires no credentials');

    const authenticated = print({ dashboardHost: '0.0.0.0', dashboardPort: undefined, proxyAuthSet: true });
    expect(authenticated).not.toContain('the proxy requires no credentials');
  });

  it('omits the open-proxy warning when not bound to the network at all', () => {
    expect(print({ dashboardHost: 'localhost', proxyAuthSet: false })).not.toContain(
      'the proxy requires no credentials',
    );
  });

  it('prints the upstream proxy URL exactly as given, already redacted by the caller', () => {
    expect(print({ upstreamProxyUrl: 'https://user:***@egress:3128' })).toContain(
      'Upstream proxy → https://user:***@egress:3128',
    );
  });

  it('reports optional facts only when they apply', () => {
    const bare = print();
    expect(bare).not.toContain('Full request/response dumps');
    expect(bare).not.toContain('History persistence');
    expect(bare).not.toContain('gRPC message decoding');

    const loaded = print({
      dumpDir: '/srv/detour/dumps',
      historyDbPath: '/srv/detour/h.db',
      protoPaths: ['a.proto', 'b.proto'],
    });
    expect(loaded).toContain('Full request/response dumps → /srv/detour/dumps');
    expect(loaded).toContain('History persistence → /srv/detour/h.db');
    expect(loaded).toContain('gRPC message decoding: 2 .proto file(s) loaded');
  });
});
