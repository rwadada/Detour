import type { Command } from 'commander';
import { hashDashboardPassword } from '../infra/dashboard/dashboardPasswordHash';
import type { UserConfig } from '../infra/fs/userConfigStore';
import { loadUserConfig, resolveUserConfigPath, writeUserConfig } from '../infra/fs/userConfigStore';
import { LAN_ACCESS_WARNING } from '../presentation/banner';
import { parseOnOff } from './optionParsers';

/**
 * Formats one `detour config` patch field for the "✔ key = value" line
 * printed after a write — `dashboardPasswordHash` gets special-cased
 * (renamed, and reported as on/off rather than the hash itself) since it's
 * the one field here that's never safe to print as-is.
 */
function describeWrittenConfigField(key: string, written: UserConfig): [label: string, value: unknown] {
  if (key === 'dashboardPasswordHash') return ['dashboardPassword', written.dashboardPasswordHash ? 'on' : 'off'];
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
    .action(async (options: { defaultDetach?: string; lan?: string; dashboardPassword?: string }) => {
      try {
        const patch: UserConfig = {};
        if (options.defaultDetach !== undefined)
          patch.defaultDetach = parseOnOff(options.defaultDetach, '--default-detach');
        if (options.lan !== undefined) patch.lanAccess = parseOnOff(options.lan, '--lan');
        if (options.dashboardPassword !== undefined) {
          const value = parseDashboardPasswordFlag(options.dashboardPassword);
          patch.dashboardPasswordHash = value === null ? null : await hashDashboardPassword(value);
        }

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
        console.log(`Config file: ${resolveUserConfigPath()}`);
      } catch (err) {
        console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });
}
