import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunState } from '../../domain/daemon/types';

/** Directory holding one JSON state file per tracked `detour start` process, keyed by its requested `--port` (~/.detour/run) — mirroring `certStore.ts`'s `resolveCertDir`/`dumpFileWriter.ts`'s `resolveDumpDir`. */
export function resolveRunDir(): string {
  const dir = path.join(os.homedir(), '.detour', 'run');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function runStateFilePath(requestedPort: number): string {
  return path.join(resolveRunDir(), `${requestedPort}.json`);
}

/** Persists `state`, overwriting whatever (if anything) was tracked for `state.requestedPort` before. */
export function writeRunState(state: RunState): void {
  fs.writeFileSync(runStateFilePath(state.requestedPort), JSON.stringify(state, null, 2));
}

/**
 * Atomically reserves the run-state slot for `state.requestedPort`, for
 * `--fail-on-running` (issue #20) — unlike the plain read-then-write
 * `findLiveRunState`/`writeRunState` pair, which leaves a window between
 * the check and the eventual write (proto/rules loading, the real port
 * bind, the dashboard bind) during which two concurrent `detour start
 * --fail-on-running` processes could both see nothing tracked yet and both
 * proceed. `fs.writeFileSync` with the `wx` flag (`O_EXCL`) is a single
 * atomic filesystem operation — whichever process's write actually creates
 * the file wins the reservation; the loser reliably sees `EEXIST` and
 * reports "already running" (exit 3) instead of losing a race it never
 * knew it was in (previously: a generic port-in-use error, exit 1).
 *
 * Self-heals a stale reservation the same way `findLiveRunState` does: an
 * `EEXIST` whose PID is no longer alive is removed and the reservation
 * retried once. Returns whether the reservation was won — the caller (see
 * `cli.ts`'s `runStart`) must `removeRunState` this same port if anything
 * after a successful reservation fails, and otherwise overwrite it with
 * `writeRunState` once the real proxy/dashboard ports are known.
 */
export function reserveRunState(state: RunState): boolean {
  const filePath = runStateFilePath(state.requestedPort);
  const tryCreate = (): boolean => {
    try {
      fs.writeFileSync(filePath, JSON.stringify(state, null, 2), { flag: 'wx' });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
  };

  if (tryCreate()) return true;
  // Lost the race, or found a stale leftover from a process that crashed
  // without cleaning up — `findLiveRunState` tells them apart, and removes
  // the file itself if it's stale (see its own doc comment).
  if (findLiveRunState(state.requestedPort)) return false;
  // Stale entry is gone now — try once more. A second EEXIST here just
  // means another process won the reservation in between; a fair loss.
  return tryCreate();
}

/** Removes the state file for `requestedPort`, if any. A no-op if it's already gone (e.g. a concurrent `detour stop` already removed it). */
export function removeRunState(requestedPort: number): void {
  fs.rmSync(runStateFilePath(requestedPort), { force: true });
}

/**
 * Whether a process with this PID is currently alive. `process.kill(pid, 0)`
 * sends no actual signal — it only probes for `ESRCH` (no such process) vs
 * success/`EPERM` (exists) per POSIX `kill(2)`, which Node mirrors on
 * Windows too (see the Node docs for `process.kill`). Only `EPERM` counts as
 * "alive but we lack permission to signal it" — anything else, including a
 * non-`ESRCH` `TypeError` from an invalid/corrupt `pid` (e.g. a stale
 * `RunState` file with a non-numeric `pid`), is treated as not alive so
 * `findLiveRunState`'s self-healing cleanup still kicks in rather than
 * getting stuck on a PID that was never valid to begin with.
 *
 * Known limitation, shared by every PID-file-based tool: this identifies
 * "still running" purely by PID, with no identity check (start time, a
 * token, etc.) against the process actually found. If a tracked process is
 * killed hard enough to skip its own cleanup (`kill -9`, a crash, power
 * loss — see `findLiveRunState`'s doc comment) and the OS happens to reuse
 * that PID for an unrelated process before the next `detour status`/`stop`
 * runs, that unrelated process is (mis)reported as the tracked detour
 * instance. Considered acceptable given how narrow the window is (a
 * specific PID reused for something else in the gap between one crash and
 * the next command) and how it's mitigated in practice (a fresh OS
 * typically doesn't reuse a recently-freed PID immediately).
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Reads back the state file for `requestedPort`, self-healing a stale entry
 * left behind by a process that died without cleaning up after itself (a
 * crash, `kill -9`, power loss) by deleting it and reporting "not running"
 * rather than a dead PID — so "Fail on Running"/`detour status`/`detour
 * stop` never trip on a ghost.
 */
export function findLiveRunState(requestedPort: number): RunState | undefined {
  const filePath = runStateFilePath(requestedPort);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
  let state: RunState;
  try {
    state = JSON.parse(raw) as RunState;
  } catch {
    // Corrupt/partial write — treat the same as "not running" rather than crash the caller.
    fs.rmSync(filePath, { force: true });
    return undefined;
  }
  if (!isProcessAlive(state.pid)) {
    fs.rmSync(filePath, { force: true });
    return undefined;
  }
  return state;
}
