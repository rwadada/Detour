import { isDumpLevel } from '../domain/dump/dumpPolicy';
import type { DumpLevel } from '../domain/dump/dumpPolicy';
import { invalidHostPatternReason } from '../domain/focus/focusPolicy';
import { isSetupTarget, SETUP_TARGETS } from '../domain/setup/targets';
import type { SetupTarget } from '../domain/setup/targets';

export function parsePort(value: string, flag: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${flag} must be an integer between 0 and 65535 (got: ${value})`);
  }
  return port;
}

export function parseDumpLevel(value: string): DumpLevel {
  if (!isDumpLevel(value)) {
    throw new Error(`--dump must be one of "summary", "full", "file" (got: ${value})`);
  }
  return value;
}

/** Validates `detour config --default-detach <on|off>` (and any future on/off config flag). Deliberately just "on"/"off" — not also "true"/"false" — so the accepted values and this error message never drift apart. */
export function parseOnOff(value: string, flag: string): boolean {
  if (value === 'on') return true;
  if (value === 'off') return false;
  throw new Error(`${flag} must be "on" or "off" (got: ${value})`);
}

/** Validates `--exit-on-idle <ms>` (issue #20): a positive integer count of milliseconds. */
export function parseIdleMs(value: string): number {
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms <= 0) {
    throw new Error(`--exit-on-idle must be a positive integer of milliseconds (got: ${value})`);
  }
  return ms;
}

/** Validates `--script-timeout-ms <ms>` (issue #161): a positive integer count of milliseconds. */
export function parseScriptTimeoutMs(value: string): number {
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms <= 0) {
    throw new Error(`--script-timeout-ms must be a positive integer of milliseconds (got: ${value})`);
  }
  return ms;
}

/** Validates `--max-capture-memory <MB>` (issue #165) and converts it to bytes, the unit `DashboardServerOptions.maxCaptureMemoryBytes` actually takes — a positive integer count of megabytes. */
export function parseMaxCaptureMemoryBytes(value: string): number {
  const mb = Number(value);
  if (!Number.isInteger(mb) || mb <= 0) {
    throw new Error(`--max-capture-memory must be a positive integer of megabytes (got: ${value})`);
  }
  return mb * 1024 * 1024;
}

export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Accumulates a repeatable flag's values into an array (commander's convention for a repeatable option) — shared by `--proto <path>` and `--upstream-ca <path>` (issue #160) so the two can't drift apart despite being logically identical. */
export function collectRepeatable(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * Splits a `--focus` value (issue #301) into host patterns: a comma-separated
 * list (`a.com,*.b.com`), trimmed, empties dropped. An empty result is an
 * error rather than "Focus off" — that is what `--no-focus` / `"off"` say —
 * so a script that forgot to fill in a value fails instead of quietly
 * intercepting every host.
 */
export function parseHostPatternList(value: string, flag: string): string[] {
  const patterns = value
    .split(',')
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern !== '');
  if (patterns.length === 0) {
    throw new Error(
      `${flag} needs at least one host pattern, e.g. ${flag} api.example.com (got: ${JSON.stringify(value)})`,
    );
  }
  for (const pattern of patterns) {
    const reason = invalidHostPatternReason(pattern);
    if (reason !== undefined) {
      throw new Error(
        `${flag} takes host patterns (api.example.com, *.example.net, host:8443) — ${JSON.stringify(pattern)} can never match a host: ${reason}`,
      );
    }
  }
  return patterns;
}

/**
 * Commander collector for the repeatable `detour start --focus <patterns>`.
 * `previous` is `undefined` before the first `--focus`, and `false` after a
 * `--no-focus` earlier on the same command line — a later `--focus` then
 * starts a fresh list.
 */
export function collectFocusPatterns(value: string, previous: string[] | boolean | undefined): string[] {
  // `detour config --focus off` clears Focus; here that would be a pattern matching no host, so say what to use.
  if (value.trim().toLowerCase() === 'off') throw new Error('--focus off is not a host pattern — use --no-focus');
  return [...(Array.isArray(previous) ? previous : []), ...parseHostPatternList(value, '--focus')];
}

/** Validates `--target`, narrowing it to `SetupTarget` — a plain guard clause doesn't narrow `options.target` itself since it's a mutable object property, so this gives `runSetupCommand` a local value TypeScript can track. */
export function parseSetupTarget(value: string | undefined): SetupTarget | undefined {
  if (value === undefined) return undefined;
  if (!isSetupTarget(value)) throw new Error(`--target must be one of ${SETUP_TARGETS.join(', ')} (got: ${value})`);
  return value;
}
