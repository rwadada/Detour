import type { RuleEngine } from '../usecase/ruleEngine';
import { logUnreachableRuleWarnings } from './logger';

/**
 * The core LAN-access security fact, worded once and reused wherever
 * `--lan`/`lanAccess` is surfaced *before* it's known whether a dashboard
 * password is configured: `--lan`'s own help text and `detour config
 * --lan`'s. One shared string so refining the wording (or the security
 * posture it describes) can't drift between hand-edited copies.
 *
 * Hedged with "unless a dashboard password is set" deliberately. Help text
 * is rendered while building the CLI, long before any config is read, so it
 * can only describe the default posture honestly — flatly asserting "no
 * authentication" would be wrong for anyone who has set one (issue #66).
 * The banner, which runs when the answer is known, says which case actually
 * applies instead of reusing this (see `printStartupBanner`).
 *
 * Mostly about the *dashboard* — the proxy itself always binds to every
 * network interface regardless of `--lan`/`lanAccess` (see `PROXY_HOST`'s
 * doc comment), since a proxy nobody else's device can reach isn't much of
 * a proxy — but it's named here too (issue #158): it's unauthenticated by
 * default, so anyone who points a device at it gets their HTTPS decrypted
 * and recorded, and `--proxy-auth` is the flag that closes that.
 * `printStartupBanner`'s own `PROXY_OPEN_WARNING` says so much louder in the
 * one place it actually matters (once it's known whether one is set).
 *
 * `web/src/features/settings-panel/ui/SettingsPanel.tsx`'s dashboard-side
 * warning says the same thing in its own words — that's a separate,
 * standalone-built package with no access to this constant, so it's worded
 * to match by hand instead. Update both together.
 */
export const LAN_ACCESS_WARNING =
  'unless a dashboard password is set (`detour config --dashboard-password`), there is no authentication at all — anyone on your network can reach the dashboard, view decrypted HTTPS traffic through it, or edit rules, and the proxy itself serves anyone who asks unless you set --proxy-auth';

/**
 * The startup banner's callout (issue #158) for the combination that
 * actually creates an open forward proxy on a shared network: `--lan`/
 * `lanAccess` on, `--proxy-auth`/`proxyAuth` unset. Worth shouting about
 * separately from `LAN_ACCESS_WARNING` because the consequence isn't
 * "someone could snoop on your session" but "someone else's traffic ends up
 * decrypted in your dumps, and your machine is their egress hop".
 */
const PROXY_OPEN_WARNING =
  'the proxy requires no credentials — anyone on your network who points a device at it has their HTTPS decrypted into this session (and can use this machine as an egress hop). Require credentials with `--proxy-auth <user:pass>`, or persist them with `detour config --proxy-auth <user:pass>`';

/**
 * The startup banner's callout for `--insecure-upstream` (issue #160) —
 * loud and unconditional (unlike `PROXY_OPEN_WARNING`, which only fires for
 * a specific risky combination) because this flag disables a safety check
 * for the *entire session*, silently: nothing about a normal request
 * signals that its upstream's certificate went unverified apart from this
 * one line at startup and the dashboard's own persistent header indicator.
 */
const INSECURE_UPSTREAM_WARNING =
  'upstream TLS certificate verification is OFF for this entire session — every proxied HTTPS request accepts whatever certificate the upstream server presents, self-signed, expired, or otherwise. Only use this against a server you trust on a network you trust; prefer `--upstream-ca <path>` to trust a specific CA instead of disabling verification outright';

/**
 * Formats `detour start`'s banner. Everything it reports is passed in
 * already resolved — whether the dashboard SPA is built, this machine's LAN
 * addresses, the upstream proxy URL with its credentials already redacted —
 * because all three come from `infra/`, which `presentation/` may not import
 * (see `boundaries/dependencies` in eslint.config.mjs). The composition root
 * resolves them; this only decides what to print.
 */
export function printStartupBanner(info: {
  /** The dashboard's own bind host (`localhost` or `0.0.0.0`) — the proxy's is always `PROXY_HOST` ('0.0.0.0'), not passed in since this function never needs to branch on it. */
  dashboardHost: string;
  /** Whether the dashboard is serving over HTTPS instead of plain HTTP (issue #159's `--dashboard-tls`) — only relevant when `dashboardPort` isn't undefined; decides the URL scheme printed for it. */
  dashboardTls: boolean;
  proxyPort: number;
  caCertPath: string;
  /** Undefined when started with `--headless`. */
  dashboardPort: number | undefined;
  ruleEngine: RuleEngine | undefined;
  dumpDir: string | undefined;
  http2Enabled: boolean;
  /** Whether the proxy→upstream leg attempts HTTP/2 at all (issue #166's `--no-http2-upstream`) — independent of `http2Enabled` above, which only ever governs the client-facing side. */
  http2UpstreamEnabled: boolean;
  protoPaths: string[];
  /** Whether `detour config --dashboard-password`/the Settings panel currently requires one (issue #66) — only relevant when `dashboardPort` isn't undefined. */
  dashboardPasswordSet: boolean;
  /** Whether `--proxy-auth`/`proxyAuth` requires credentials from every proxy client (issue #158). */
  proxyAuthSet: boolean;
  /** `--persist`'s resolved SQLite path (issue #144), undefined when not given. */
  historyDbPath: string | undefined;
  /** `--upstream-proxy`'s URL (issue #145) with any credentials already redacted, undefined when not given. */
  upstreamProxyUrl: string | undefined;
  /** Whether `npm run build` has produced a dashboard SPA to serve — decides between the plain dashboard URL and the "not built yet" variant. */
  dashboardBuilt: boolean;
  /** This machine's LAN addresses, for the "reachable on your network at" list. */
  lanAddresses: string[];
  /** Whether `--insecure-upstream` (issue #160) is disabling upstream TLS certificate verification for this session. */
  insecureUpstream: boolean;
  /** How many `--upstream-ca <path>` CAs were loaded (issue #160), 0 when none. */
  upstreamCaCount: number;
  /** Whether `--client-cert`/`--client-key` (issue #160) are configured for mTLS. */
  clientCertSet: boolean;
}): void {
  console.log(
    `Detour proxy started → http://localhost:${info.proxyPort} (HTTP/2: ${info.http2Enabled ? 'on' : 'off'}, upstream HTTP/2: ${info.http2UpstreamEnabled ? 'on' : 'off'})`,
  );
  console.log(`Proxy authentication: ${info.proxyAuthSet ? 'required (Basic)' : 'off (--proxy-auth <user:pass>)'}`);
  console.log(`Root CA certificate: ${info.caCertPath}`);
  console.log('  To decrypt HTTPS traffic, install this CA certificate as trusted on your target device/browser.');
  const dashboardScheme = info.dashboardTls ? 'https' : 'http';
  if (info.dashboardPort === undefined) {
    console.log('Dashboard → disabled (--headless)');
  } else if (info.dashboardBuilt) {
    console.log(`Dashboard → ${dashboardScheme}://localhost:${info.dashboardPort}`);
  } else {
    console.log(
      `Dashboard → ${dashboardScheme}://localhost:${info.dashboardPort} (not built yet — run \`npm run build\`, or use \`npm run dev:dashboard\` for a dev server with hot reload)`,
    );
  }
  if (info.dashboardPort !== undefined) {
    console.log(
      `Dashboard transport: ${info.dashboardTls ? "HTTPS (Detour's CA)" : 'HTTP (--dashboard-tls on to encrypt)'}`,
    );
    console.log(
      `Dashboard password: ${info.dashboardPasswordSet ? 'required' : 'off (detour config --dashboard-password <value>)'}`,
    );
  }
  // The proxy (unlike the dashboard) always binds to every network
  // interface — see `PROXY_HOST`'s doc comment — so its LAN address is
  // always worth printing, `--lan`/`lanAccess` or not: `localhost` on a
  // *different* device resolves to that device, not this machine, so the
  // `localhost` URL printed above is useless to whoever's supposed to reach
  // the proxy from elsewhere on the network. The dashboard only joins this
  // list (and only then gets the SECURITY callout below) when it's
  // actually bound to every interface too.
  const lanEnabled = info.dashboardHost !== 'localhost';
  const dashboardOnLan = info.dashboardPort !== undefined && lanEnabled;
  const addresses = info.lanAddresses;
  if (addresses.length > 0) {
    console.log('Reachable on your network at:');
    for (const address of addresses) {
      console.log(`  Proxy     → http://${address}:${info.proxyPort}`);
      if (dashboardOnLan) console.log(`  Dashboard → ${dashboardScheme}://${address}:${info.dashboardPort}`);
    }
  }
  if (dashboardOnLan) {
    // `--lan`/`detour config --lan on`: called out loudly rather than
    // folded quietly into the URL above — anyone on the network can reach
    // the dashboard and, from there, decrypted HTTPS traffic and rule edits
    // (the proxy itself isn't part of this warning: it's always reachable
    // this way, and has no comparable rule-editing/traffic-viewing surface
    // to expose — see `LAN_ACCESS_WARNING`'s doc comment).
    //
    // Stated outright rather than reusing `LAN_ACCESS_WARNING`'s hedged
    // help-text wording: by now it's known which case applies. The old
    // unconditional "no authentication of any kind" contradicted the
    // `Dashboard password: required` line printed just above it whenever
    // one was actually set (issue #66), telling a user who had done the
    // right thing that it counted for nothing.
    const risk = info.dashboardPasswordSet
      ? 'the dashboard password is the only thing standing between anyone on your network and decrypted HTTPS traffic or rule edits'
      : 'no dashboard password is set (detour config --dashboard-password), so anyone on your network can reach the dashboard, view decrypted HTTPS traffic through it, or edit rules';
    console.log(
      `⚠ Dashboard bound to every network interface, not just this machine — SECURITY: ${risk}. Only do this on a network you trust.`,
    );
  }
  // Issue #158. Keyed off `--lan`/`lanAccess` (`lanEnabled`, what
  // `dashboardHost` encodes) rather than `dashboardOnLan`: the proxy is
  // reachable from the network either way, so `--headless --lan` — a
  // CI/scripted session with no dashboard at all — needs this warning just
  // as much. Not keyed off "is this machine actually on a network"
  // (`lanAddresses`), since `--lan` is an explicit statement of intent to be
  // reachable, and a warning that disappeared while offline would be
  // missing exactly when someone joins a café Wi-Fi mid-session.
  if (lanEnabled && !info.proxyAuthSet) {
    console.log(`⚠ SECURITY: ${PROXY_OPEN_WARNING}.`);
  }
  if (info.ruleEngine) {
    console.log(
      `Rules file: ${info.ruleEngine.filePath} (loaded ${info.ruleEngine.getRules().length} rule(s), watching for changes)`,
    );
    logUnreachableRuleWarnings(info.ruleEngine.getUnreachableWarnings());
  }
  if (info.dumpDir) {
    console.log(`Full request/response dumps → ${info.dumpDir}`);
  }
  if (info.protoPaths.length > 0) {
    console.log(`gRPC message decoding: ${info.protoPaths.length} .proto file(s) loaded`);
  }
  if (info.historyDbPath) {
    console.log(`History persistence → ${info.historyDbPath}`);
  }
  if (info.upstreamProxyUrl) {
    console.log(`Upstream proxy → ${info.upstreamProxyUrl}`);
  }
  if (info.upstreamCaCount > 0) {
    console.log(`Upstream CA trust → ${info.upstreamCaCount} additional CA(s) loaded (--upstream-ca)`);
  }
  if (info.clientCertSet) {
    console.log('Upstream client certificate → configured (--client-cert/--client-key)');
  }
  // Loud and unconditional (issue #160) — see `INSECURE_UPSTREAM_WARNING`'s
  // own doc comment for why this doesn't get the same "only for a specific
  // risky combination" treatment as `PROXY_OPEN_WARNING` above.
  if (info.insecureUpstream) {
    console.log(`⚠ SECURITY: ${INSECURE_UPSTREAM_WARNING}.`);
  }
  console.log('Press Ctrl+C to stop.');
}
