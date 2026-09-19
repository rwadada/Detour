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
 * Scoped to the *dashboard* only — the proxy itself always binds to every
 * network interface regardless of `--lan`/`lanAccess` (see `PROXY_HOST`'s
 * doc comment), since a proxy nobody else's device can reach isn't much of
 * a proxy. This warning exists because the dashboard is the one piece
 * `--lan` still actually gates: it's where decrypted HTTPS traffic and rule
 * edits live.
 *
 * `web/src/features/settings-panel/ui/SettingsPanel.tsx`'s dashboard-side
 * warning says the same thing in its own words — that's a separate,
 * standalone-built package with no access to this constant, so it's worded
 * to match by hand instead. Update both together.
 */
export const LAN_ACCESS_WARNING =
  'unless a dashboard password is set (`detour config --dashboard-password`), there is no authentication at all — anyone on your network can reach the dashboard, view decrypted HTTPS traffic through it, or edit rules';

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
  proxyPort: number;
  caCertPath: string;
  /** Undefined when started with `--headless`. */
  dashboardPort: number | undefined;
  ruleEngine: RuleEngine | undefined;
  dumpDir: string | undefined;
  http2Enabled: boolean;
  protoPaths: string[];
  /** Whether `detour config --dashboard-password`/the Settings panel currently requires one (issue #66) — only relevant when `dashboardPort` isn't undefined. */
  dashboardPasswordSet: boolean;
  /** `--persist`'s resolved SQLite path (issue #144), undefined when not given. */
  historyDbPath: string | undefined;
  /** `--upstream-proxy`'s URL (issue #145) with any credentials already redacted, undefined when not given. */
  upstreamProxyUrl: string | undefined;
  /** Whether `npm run build` has produced a dashboard SPA to serve — decides between the plain dashboard URL and the "not built yet" variant. */
  dashboardBuilt: boolean;
  /** This machine's LAN addresses, for the "reachable on your network at" list. */
  lanAddresses: string[];
}): void {
  console.log(
    `Detour proxy started → http://localhost:${info.proxyPort} (HTTP/2: ${info.http2Enabled ? 'on' : 'off'})`,
  );
  console.log(`Root CA certificate: ${info.caCertPath}`);
  console.log('  To decrypt HTTPS traffic, install this CA certificate as trusted on your target device/browser.');
  if (info.dashboardPort === undefined) {
    console.log('Dashboard → disabled (--headless)');
  } else if (info.dashboardBuilt) {
    console.log(`Dashboard → http://localhost:${info.dashboardPort}`);
  } else {
    console.log(
      `Dashboard → http://localhost:${info.dashboardPort} (not built yet — run \`npm run build\`, or use \`npm run dev:dashboard\` for a dev server with hot reload)`,
    );
  }
  if (info.dashboardPort !== undefined) {
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
  const dashboardOnLan = info.dashboardPort !== undefined && info.dashboardHost !== 'localhost';
  const addresses = info.lanAddresses;
  if (addresses.length > 0) {
    console.log('Reachable on your network at:');
    for (const address of addresses) {
      console.log(`  Proxy     → http://${address}:${info.proxyPort}`);
      if (dashboardOnLan) console.log(`  Dashboard → http://${address}:${info.dashboardPort}`);
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
  console.log('Press Ctrl+C to stop.');
}
