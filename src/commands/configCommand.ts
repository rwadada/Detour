import type { Command } from 'commander';
import { hashPassword } from '../domain/auth/passwordHash';
import { parseProxyAuthFlag } from '../domain/auth/proxyAuth';
import type { ProxyAuthCredentials } from '../domain/auth/proxyAuth';
import type { UserConfig } from '../infra/fs/userConfigStore';
import { loadUserConfig, resolveUserConfigPath, writeUserConfig } from '../infra/fs/userConfigStore';
import { normalizeFocusHosts } from '../domain/focus/focusPolicy';
import { LAN_ACCESS_WARNING } from '../presentation/banner';
import { parseHostPatternList, parseOnOff } from './optionParsers';

/**
 * Renders `proxyAuth` for a `detour config` line — never the raw object
 * (it holds a password hash), just whether one's set and, if so, for whom.
 * Factored out rather than inlined as a nested template literal at each of
 * its two call sites (a linter's, and a readable one's, complaint alike).
 */
function describeProxyAuth(proxyAuth: ProxyAuthCredentials | null | undefined): string {
  return proxyAuth ? `on (user ${proxyAuth.username})` : 'off';
}

/**
 * Formats one `detour config` patch field for the "✔ key = value" line
 * printed after a write — `dashboardPasswordHash`/`proxyAuth` get
 * special-cased (renamed, and reported as on/off rather than the raw value)
 * since they're never safe to print as-is: one's a hash, the other an
 * object holding one.
 */
function describeWrittenConfigField(key: string, written: UserConfig): [label: string, value: unknown] {
  if (key === 'dashboardPasswordHash') return ['dashboardPassword', written.dashboardPasswordHash ? 'on' : 'off'];
  if (key === 'proxyAuth') return ['proxyAuth', describeProxyAuth(written.proxyAuth)];
  if (key === 'focusHosts') return ['focusHosts', describeFocusHosts(written.focusHosts)];
  return [key, written[key]];
}

/**
 * Validates `detour config --dashboard-password <value>`: `"off"` clears
 * it (returned as `null`, matching `UserConfig.dashboardPasswordHash`'s
 * own "unset" value); anything else must be non-empty — an accidentally-
 * empty value (a script that forgot to interpolate one, say) would
 * otherwise silently set a real, trivially-guessable password while
 * still reporting `dashboardPassword = on`, which is worse than not
 * setting one at all. `dashboardServer.ts`'s `setDashboardPassword`
 * handler rejects the same thing for the Settings-panel/WebSocket path.
 */
function parseDashboardPasswordFlag(value: string): string | null {
  if (value === 'off') return null;
  if (value === '') throw new Error('--dashboard-password must not be empty (pass "off" to remove it)');
  return value;
}

/** Wires `detour config` into the CLI. */
export function registerConfigCommand(program: Command): void {
  program
    .command('config')
    .description('View or change persistent `detour start` preferences, stored in ~/.detour/config.json')
    .option(
      '--default-detach <on|off>',
      'When "on", `detour start` runs detached by default (as if --detach were always passed) — override per-invocation with --detach/--foreground.',
    )
    .option(
      '--lan <on|off>',
      `When "on", \`detour start\` binds the dashboard to every network interface (0.0.0.0) by default (the proxy always does, on or off) — override per-invocation with --lan/--no-lan. SECURITY: ${LAN_ACCESS_WARNING}.`,
    )
    .option(
      '--dashboard-password <value>',
      'Require this password before the dashboard will send any traffic, rules, or accept any control message over its WebSocket connection (issue #66). Pass "off" to remove it. Independent of --lan; takes effect for new connections immediately (no restart needed); stored hashed, never in plaintext.',
    )
    .option(
      '--proxy-auth <user:pass>',
      'Require these credentials (HTTP Basic, via Proxy-Authorization) from every client of the *proxy* before it will serve them (issue #158) — the counterpart to --dashboard-password, for the port that actually carries traffic. Pass "off" to remove them. Read at `detour start`, so a change needs a restart; the password is stored hashed, never in plaintext.',
    )
    .option(
      '--auto-passthrough <on|off>',
      'When "off", `detour start` keeps MITM-ing a host even after its client refused Detour\'s certificate, instead of relaying it as raw TLS from then on (on by default) — override per-invocation with --auto-passthrough/--no-auto-passthrough. Read at `detour start`, so a change needs a restart.',
    )
    .option(
      '--intercept <on|off>',
      'When "off", `detour start` begins with Intercept off: every HTTPS connection is relayed untouched, nothing is decrypted (on by default) — for using Detour only as a route (e.g. to this machine\'s VPN). Override per-invocation with --intercept/--no-intercept; the dashboard can still toggle it. Read at `detour start`, so a change needs a restart.',
    )
    .option(
      '--focus <patterns>',
      'Host patterns `detour start` begins with in Focus, comma-separated (e.g. "api.example.com,*.example.net"): only matching hosts are decrypted, every other host is relayed untouched. Pass "off" to clear it (every host is decrypted, the default). Override per-invocation with --focus/--no-focus; the dashboard can still change it. Read at `detour start`, so a change needs a restart.',
    )
    .action(runConfigCommand);
}

interface ConfigCommandOptions {
  defaultDetach?: string;
  lan?: string;
  dashboardPassword?: string;
  proxyAuth?: string;
  autoPassthrough?: string;
  intercept?: string;
  focus?: string;
}

/** `detour config --focus`: `"off"` (any case, surrounding spaces ignored) clears it (stored as `[]`), anything else is a host pattern list. */
function parseFocusConfigFlag(value: string): string[] {
  return value.trim().toLowerCase() === 'off' ? [] : normalizeFocusHosts(parseHostPatternList(value, '--focus'));
}

/** Renders `focusHosts` for a `detour config` line. */
function describeFocusHosts(focusHosts: readonly string[] | undefined): string {
  return focusHosts && focusHosts.length > 0 ? focusHosts.join(', ') : 'off';
}

/** Turns `detour config`'s flags into a `UserConfig` patch, hashing any password on the way. */
async function buildConfigPatch(options: ConfigCommandOptions): Promise<UserConfig> {
  const patch: UserConfig = {};
  if (options.defaultDetach !== undefined) patch.defaultDetach = parseOnOff(options.defaultDetach, '--default-detach');
  if (options.lan !== undefined) patch.lanAccess = parseOnOff(options.lan, '--lan');
  if (options.autoPassthrough !== undefined)
    patch.autoPassthrough = parseOnOff(options.autoPassthrough, '--auto-passthrough');
  if (options.intercept !== undefined) patch.intercept = parseOnOff(options.intercept, '--intercept');
  if (options.focus !== undefined) patch.focusHosts = parseFocusConfigFlag(options.focus);
  if (options.dashboardPassword !== undefined) {
    const value = parseDashboardPasswordFlag(options.dashboardPassword);
    patch.dashboardPasswordHash = value === null ? null : await hashPassword(value);
  }
  if (options.proxyAuth !== undefined) {
    if (options.proxyAuth === 'off') {
      patch.proxyAuth = null;
    } else {
      const { username, password } = parseProxyAuthFlag(options.proxyAuth, '--proxy-auth');
      patch.proxyAuth = { username, passwordHash: await hashPassword(password) };
    }
  }
  return patch;
}

/** `detour config`: writes whatever the flags set, or prints every setting when none were given. */
async function runConfigCommand(options: ConfigCommandOptions): Promise<void> {
  try {
    const patch = await buildConfigPatch(options);
    if (Object.keys(patch).length > 0) {
      const written = writeUserConfig(patch);
      for (const key of Object.keys(patch)) {
        const [label, value] = describeWrittenConfigField(key, written);
        console.log(`✔ ${label} = ${value} (${resolveUserConfigPath()})`);
      }
      return;
    }
    const config = loadUserConfig();
    console.log(`defaultDetach = ${config.defaultDetach ?? false}`);
    console.log(`lanAccess = ${config.lanAccess ?? false}`);
    console.log(`dashboardPassword = ${config.dashboardPasswordHash ? 'on' : 'off'}`);
    console.log(`proxyAuth = ${describeProxyAuth(config.proxyAuth)}`);
    console.log(`autoPassthrough = ${config.autoPassthrough ?? true}`);
    console.log(`intercept = ${config.intercept ?? true}`);
    console.log(`focusHosts = ${describeFocusHosts(config.focusHosts)}`);
    console.log(`Config file: ${resolveUserConfigPath()}`);
  } catch (err) {
    console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
