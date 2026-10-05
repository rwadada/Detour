/** Added only by an update restart (see `buildRestartArgs`), so it must never be replayed by the next one. */
export const RESUME_BACKLOG_FLAG = '--resume-backlog';

const NON_REPLAYED_FLAGS = new Set(['--detach', '--foreground', RESUME_BACKLOG_FLAG]);

/**
 * The `detour start` arguments worth replaying on an update restart: argv
 * after the `start` subcommand, minus the flags that choose foreground vs
 * background (the restart decides that itself — see `buildRestartArgs`) and
 * the one-shot `--resume-backlog`. Callers pass `process.argv.slice(3)`.
 */
export function extractStartArgs(argsAfterStart: string[]): string[] {
  return argsAfterStart.filter((arg) => !NON_REPLAYED_FLAGS.has(arg));
}

/**
 * Full argv (after the executable) to relaunch an instance as a background
 * daemon. Always detached — whoever ran the original foreground process is
 * no longer there to hold its terminal — with `--no-open` so an update never
 * pops a browser tab the user already has open, and with `--resume-backlog`
 * so the relaunched instance picks back up the captured traffic the old one
 * saved on its way out (a no-op when it saved none).
 */
export function buildRestartArgs(startArgs: string[]): string[] {
  const args = extractStartArgs(startArgs);
  if (!args.includes('--no-open')) args.push('--no-open');
  return ['start', ...args, RESUME_BACKLOG_FLAG, '--detach'];
}
