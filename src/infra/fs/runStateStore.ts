import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunState } from '../../domain/daemon/types';
import { publishOwnerOnlyFile, writeOwnerOnlyFile } from './ownerOnly';

/** Directory holding one JSON state file per tracked `detour start` process, keyed by its requested `--port` (~/.detour/run) — mirroring `certStore.ts`'s `resolveCertDir`/`dumpFileWriter.ts`'s `resolveDumpDir`. */
export function resolveRunDir(): string {
  const dir = path.join(os.homedir(), '.detour', 'run');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * State files carry the original `detour start` arguments, which can include
 * credentials (`--proxy-auth`), so they are written owner-only (`ownerOnly.ts`).
 *
 * A file that doesn't parse is taken for a crashed leftover and removed —
 * unless it was modified this recently, in which case it may be another
 * process's write still in progress (an older Detour wrote in place).
 */
const UNPARSEABLE_GRACE_MS = 5_000;

function runStateFilePath(requestedPort: number): string {
  return path.join(resolveRunDir(), `${requestedPort}.json`);
}

/**
 * Persists `state`, overwriting whatever (if anything) was tracked for
 * `state.requestedPort` before. Replaced in one step (a temporary file
 * renamed over it), never truncated in place: a reader in between — `detour
 * status`, another `--fail-on-running` start — would otherwise see an empty
 * file, take it for a corrupt leftover and delete a live process's entry.
 */
export function writeRunState(state: RunState): void {
  writeOwnerOnlyFile(runStateFilePath(state.requestedPort), JSON.stringify(state, null, 2));
}

/**
 * Atomically reserves the run-state slot for `state.requestedPort`, for
 * `--fail-on-running` (issue #20) — unlike the plain read-then-write
 * `findLiveRunState`/`writeRunState` pair, which leaves a window between
 * the check and the eventual write (proto/rules loading, the real port
 * bind, the dashboard bind) during which two concurrent `detour start
 * --fail-on-running` processes could both see nothing tracked yet and both
 * proceed. The state is written to a temporary file first and then
 * hard-linked into place: `link` fails with `EEXIST` when the name is taken,
 * atomically, so whichever process links first wins, and the file is never
 * visible half-written. (A plain `writeFileSync` with `wx` creates the file
 * empty and fills it afterwards; a loser reading it in that gap took it for
 * a corrupt leftover, deleted it and won too — both then started, and one
 * failed on the port with exit 1 instead of reporting exit 3.)
 *
 * Self-heals a stale reservation: an `EEXIST` whose PID is no longer alive is
 * moved aside (`moveAsideIfStale`) and the reservation retried once. Returns whether the reservation was won — the caller (see
 * `cli.ts`'s `runStart`) must `removeRunState` this same port if anything
 * after a successful reservation fails, and otherwise overwrite it with
 * `writeRunState` once the real proxy/dashboard ports are known.
 */
export function reserveRunState(state: RunState): boolean {
  const filePath = runStateFilePath(state.requestedPort);
  const content = JSON.stringify(state, null, 2);
  if (publishOwnerOnlyFile(filePath, content)) return true;
  // Lost the race, or found a stale leftover from a process that crashed without cleaning up.
  if (!moveAsideIfStale(filePath)) return false;
  // The stale entry is gone now — try once more. A second EEXIST here just
  // means another process won the reservation in between; a fair loss.
  return publishOwnerOnlyFile(filePath, content);
}

/**
 * Takes a stale reservation out of the way, returning whether the slot is
 * free now. A reservation still in use is judged by name and left untouched.
 * One judged stale is renamed to a name only this process uses and judged
 * again there — deleting by name after the first read could delete a live
 * reservation that replaced the stale one in between, letting both win (an
 * inode comparison can't tell them apart: a freed inode is reused at once on
 * Linux). If the parked file turns out to be in use, it is put back; only a
 * third reservation landing in that instant could still slip in — a stale
 * leftover and three racing starts at once.
 */
function moveAsideIfStale(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return true;
  if (isInUse(filePath)) return false;
  const parked = `${filePath}.${process.pid}.parked`;
  try {
    fs.renameSync(filePath, parked);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw err;
  }
  if (!isInUse(parked)) {
    fs.rmSync(parked, { force: true });
    return true;
  }
  try {
    fs.linkSync(parked, filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  fs.rmSync(parked, { force: true });
  return false;
}

/** Whether the state file at `filePath` belongs to a live process, or is unparseable but may still be being written. */
function isInUse(filePath: string): boolean {
  const state = readRunStateFile(filePath);
  return state ? isProcessAlive(state.pid) : modifiedWithin(filePath, UNPARSEABLE_GRACE_MS);
}

/** Parses a state file, or `undefined` when it is missing or doesn't parse. */
function readRunStateFile(filePath: string): RunState | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as RunState;
  } catch {
    return undefined;
  }
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
    // Corrupt/partial write — treat the same as "not running" rather than crash the caller, and remove it unless
    // it may still be being written (see `UNPARSEABLE_GRACE_MS`).
    if (!modifiedWithin(filePath, UNPARSEABLE_GRACE_MS)) fs.rmSync(filePath, { force: true });
    return undefined;
  }
  if (!isProcessAlive(state.pid)) {
    fs.rmSync(filePath, { force: true });
    return undefined;
  }
  return state;
}

function modifiedWithin(filePath: string, ms: number): boolean {
  try {
    return Date.now() - fs.statSync(filePath).mtimeMs < ms;
  } catch {
    return false;
  }
}

/** Every instance currently tracked as running, across all ports (self-healing stale entries as `findLiveRunState` does). */
export function listLiveRunStates(): RunState[] {
  const dir = resolveRunDir();
  const states: RunState[] = [];
  for (const name of fs.readdirSync(dir)) {
    const match = /^(\d+)\.json$/.exec(name);
    if (!match) continue;
    const state = findLiveRunState(Number(match[1]));
    if (state) states.push(state);
  }
  return states.sort((a, b) => a.requestedPort - b.requestedPort);
}
