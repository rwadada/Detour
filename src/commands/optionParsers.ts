import { isDumpLevel } from '../domain/dump/dumpPolicy';
import type { DumpLevel } from '../domain/dump/dumpPolicy';
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

/** Validates `--target`, narrowing it to `SetupTarget` — a plain guard clause doesn't narrow `options.target` itself since it's a mutable object property, so this gives `runSetupCommand` a local value TypeScript can track. */
export function parseSetupTarget(value: string | undefined): SetupTarget | undefined {
  if (value === undefined) return undefined;
  if (!isSetupTarget(value)) throw new Error(`--target must be one of ${SETUP_TARGETS.join(', ')} (got: ${value})`);
  return value;
}
