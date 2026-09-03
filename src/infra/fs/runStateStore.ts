import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunState } from '../../domain/daemon/types';

/** Directory holding one JSON state file per tracked `detour start` process, keyed by its requested `--port` (~/.detour/run). */
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
