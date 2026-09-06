export interface CommandResult {
  stdout: string;
  stderr: string;
}

/**
 * Thrown by a `CommandRunner` on a nonzero exit or a missing binary
 * (`ENOENT`) — one error shape so callers (the per-target setup/doctor/
 * cleanup usecases) can catch it and turn it into a `'failed'`/`'skipped'`
 * step without inspecting `child_process`-specific error shapes themselves.
 *
 * `notFound` distinguishes "the binary itself isn't installed" (ENOENT)
 * from any other nonzero-exit failure — set explicitly by the real
 * `CommandRunner` (`infra/process/nodeCommandRunner.ts`) from the
 * underlying error's actual `.code`, rather than callers guessing from
 * `.message` text (which can vary by wording/locale and, worse, can
 * coincidentally contain "not found" for a real failure unrelated to a
 * missing binary — see `linux.ts`'s `gsettingsFailureStep`, which this
 * field exists for).
 */
export class CommandRunError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly notFound: boolean = false,
  ) {
    super(message);
    this.name = 'CommandRunError';
  }
}

/**
 * Runs an external command to completion — the seam every `detour
 * setup`/`doctor`/`cleanup` automation (macOS `security`/`networksetup`,
 * `adb`, Linux `gsettings`) calls through instead of touching
 * `node:child_process` directly, so the per-target usecases can be unit
 * tested against a fake runner instead of the real OS tools. Implemented
 * against the real OS by `infra/process/nodeCommandRunner.ts`.
 *
 * Deliberately takes `command`/`args` separately (never a shell string) —
 * no shell is involved, so there's nothing for a cert path or network
 * service name containing spaces or shell metacharacters to break out of.
 */
export interface CommandRunner {
  run(command: string, args: string[]): Promise<CommandResult>;
}
