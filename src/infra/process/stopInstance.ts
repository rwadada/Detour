import type { RunState } from '../../domain/daemon/types';
import { isProcessAlive, removeRunState } from '../fs/runStateStore';

/** How long `stopInstance` waits for a SIGTERM'd process to exit on its own before escalating to SIGKILL. */
export const STOP_GRACE_PERIOD_MS = 10_000;

const SIGKILL_REAP_MS = 2_000;

function signalIgnoringGone(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
  }
}

/**
 * Stops the tracked instance: SIGTERM, wait up to `gracePeriodMs` for it to
 * exit on its own, then SIGKILL. Shared by `detour stop` and `detour update`.
 */
export async function stopInstance(state: RunState, gracePeriodMs: number = STOP_GRACE_PERIOD_MS): Promise<void> {
  signalIgnoringGone(state.pid, 'SIGTERM');
  const deadline = Date.now() + gracePeriodMs;
  while (isProcessAlive(state.pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (isProcessAlive(state.pid)) {
    signalIgnoringGone(state.pid, 'SIGKILL');
    // Let the kernel release its listening ports before a relaunch can race for them.
    const killDeadline = Date.now() + SIGKILL_REAP_MS;
    while (isProcessAlive(state.pid) && Date.now() < killDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  // Self-healing (see findLiveRunState): normally the process removes
  // its own state file as part of graceful shutdown, but a SIGKILL after
  // the grace period skips that — clean it up here either way.
  removeRunState(state.requestedPort);
}
