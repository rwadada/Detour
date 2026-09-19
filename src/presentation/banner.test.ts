import { afterEach, describe, expect, it, vi } from 'vitest';
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

  /** Clears first, so two calls in one test compare two banners rather than one concatenated with the other. */
  function print(overrides: Partial<Parameters<typeof printStartupBanner>[0]> = {}): string {
    logged.length = 0;
    printStartupBanner({
      dashboardHost: 'localhost',
      proxyPort: 8080,
      caCertPath: '/home/u/.detour/certs/certs/ca.pem',
      dashboardPort: 9080,
      ruleEngine: undefined,
      dumpDir: undefined,
      http2Enabled: true,
      protoPaths: [],
      dashboardPasswordSet: false,
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

  it('warns loudly when the dashboard is bound to every interface', () => {
    expect(print({ dashboardHost: '0.0.0.0' })).toContain('SECURITY');
    expect(print({ dashboardHost: 'localhost' })).not.toContain('SECURITY');
  });

  it('omits the LAN warning for a headless run, which has no dashboard to expose', () => {
    expect(print({ dashboardHost: '0.0.0.0', dashboardPort: undefined })).not.toContain('SECURITY');
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
