/**
 * The `detour start` arguments worth replaying on an update restart: argv
 * after the `start` subcommand, minus the flags that choose foreground vs
 * background (the restart decides that itself — see `buildRestartArgs`).
 * Callers pass `process.argv.slice(3)`.
 */
export function extractStartArgs(argsAfterStart: string[]): string[] {
  return argsAfterStart.filter((arg) => arg !== '--detach' && arg !== '--foreground');
}

/**
 * Full argv (after the executable) to relaunch an instance as a background
 * daemon. Always detached — whoever ran the original foreground process is
 * no longer there to hold its terminal — and `--no-open` so an update never
 * pops a browser tab the user already has open.
 */
export function buildRestartArgs(startArgs: string[]): string[] {
  const args = extractStartArgs(startArgs);
  if (!args.includes('--no-open')) args.push('--no-open');
  return ['start', ...args, '--detach'];
}
