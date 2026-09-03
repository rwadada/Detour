/**
 * A CLI-level failure that must exit with a specific, non-1 status code —
 * currently just "Fail on Running" (issue #20: `exit 3` when an instance is
 * already running for the requested port), surfaced through both the
 * foreground path and the `--detach` daemon-child IPC handshake (see
 * `infra/process/daemonize.ts`). `cli.ts`'s top-level action handlers check
 * for this type to set `process.exitCode` precisely instead of falling back
 * to the generic `1` used for every other error.
 */
export class CliExitError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = 'CliExitError';
    this.exitCode = exitCode;
  }
}
