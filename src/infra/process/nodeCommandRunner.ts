import { execFile } from 'node:child_process';
import type { CommandResult, CommandRunner } from '../../usecase/ports/commandRunner';
import { CommandRunError } from '../../usecase/ports/commandRunner';

/** Real `CommandRunner` (see that file's doc comment) — shells out via `execFile` (no shell, see `CommandRunner`'s doc comment on why). */
export const nodeCommandRunner: CommandRunner = {
  run(command: string, args: string[]): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      execFile(command, args, { timeout: 15_000 }, (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          const message =
            code === 'ENOENT' ? `"${command}" not found — is it installed and on PATH?` : stderr.trim() || err.message;
          reject(new CommandRunError(message, command));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  },
};
