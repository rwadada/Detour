import type { Command } from 'commander';
import { findLiveRunState, isProcessAlive, removeRunState } from '../infra/fs/runStateStore';
import { parsePort } from './optionParsers';

/** How long `detour stop` waits for a SIGTERM'd process to exit on its own before escalating to SIGKILL. */
export const STOP_GRACE_PERIOD_MS = 10_000;

/** Shared by `detour status`/`detour stop` (issue #20) when nothing is tracked as running on `port`. */
export function reportNotRunning(port: number): void {
  console.log(`detour is not running on port ${port}.`);
  process.exitCode = 1;
}

/** Wires `detour status`/`detour stop` into the CLI (issue #20's run-state tracking). */
export function registerProcessCommands(program: Command): void {
  program
    .command('status')
    .description('Shows whether a detour instance (--detach or foreground) is running on the given --port (issue #20)')
    .option('-p, --port <port>', 'Port to check (matches the --port a `detour start` was given)', '8080')
    .action((options: { port: string }) => {
      try {
        const port = parsePort(options.port, '--port');
        const state = findLiveRunState(port);
        if (!state) {
          reportNotRunning(port);
          return;
        }
        console.log(
          `✔ detour is running on port ${port} (pid ${state.pid}${state.detached ? ', detached' : ', foreground'})`,
        );
        console.log(`  Proxy     → http://localhost:${state.proxyPort}`);
        console.log(
          state.dashboardPort !== undefined
            ? `  Dashboard → http://localhost:${state.dashboardPort}`
            : '  Dashboard → disabled (--headless)',
        );
        console.log(`  Started   → ${new Date(state.startedAt).toISOString()}`);
        if (state.logFile) console.log(`  Logs      → ${state.logFile}`);
      } catch (err) {
        console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  program
    .command('stop')
    .description('Stops a detour instance (--detach or foreground) running on the given --port (issue #20)')
    .option('-p, --port <port>', 'Port of the instance to stop (matches the --port it was given)', '8080')
    .action(async (options: { port: string }) => {
      try {
        const port = parsePort(options.port, '--port');
        const state = findLiveRunState(port);
        if (!state) {
          reportNotRunning(port);
          return;
        }
        try {
          process.kill(state.pid, 'SIGTERM');
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
        }
        const deadline = Date.now() + STOP_GRACE_PERIOD_MS;
        while (isProcessAlive(state.pid) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (isProcessAlive(state.pid)) {
          try {
            process.kill(state.pid, 'SIGKILL');
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
          }
        }
        // Self-healing (see findLiveRunState): normally the process removes
        // its own state file as part of graceful shutdown, but a SIGKILL after
        // the grace period skips that — clean it up here either way.
        removeRunState(port);
        console.log(`✔ Stopped detour (pid ${state.pid}) on port ${port}.`);
      } catch (err) {
        console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });
}
