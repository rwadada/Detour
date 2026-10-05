import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CapturedExchange } from '../../domain/exchange/types';
import { parseBacklogSnapshot, serializeBacklogSnapshot } from '../../domain/update/backlogSnapshot';

/** The snapshot holds decrypted traffic (Authorization headers, bodies…) — owner-only, like the run-state files. */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

function snapshotDir(): string {
  return path.join(os.homedir(), '.detour', 'update-resume');
}

/** One file per requested `--port`, so concurrent instances never read each other's traffic. */
export function backlogSnapshotPath(requestedPort: number): string {
  return path.join(snapshotDir(), `${requestedPort}.json`);
}

export function writeBacklogSnapshot(
  requestedPort: number,
  items: readonly CapturedExchange[],
  now: number = Date.now(),
): void {
  const dir = snapshotDir();
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  // `mode` only applies when the directory is created; tighten one that already existed.
  fs.chmodSync(dir, DIR_MODE);
  const filePath = backlogSnapshotPath(requestedPort);
  const tmpPath = tmpSnapshotPath(requestedPort);
  removeQuietly(tmpPath);
  try {
    fs.writeFileSync(tmpPath, serializeBacklogSnapshot(items, now), { mode: FILE_MODE });
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    removeQuietly(tmpPath);
    throw err;
  }
}

/** Fixed name (not per-pid) so a write cut short by SIGKILL is swept by the next discard/take. */
function tmpSnapshotPath(requestedPort: number): string {
  return `${backlogSnapshotPath(requestedPort)}.tmp`;
}

/** Cleanup is best effort: a file we can't remove must never stop Detour from starting. */
function removeQuietly(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // ignore
  }
}

export function discardBacklogSnapshot(requestedPort: number): void {
  removeQuietly(backlogSnapshotPath(requestedPort));
  removeQuietly(tmpSnapshotPath(requestedPort));
}

/**
 * Reads the snapshot for `requestedPort` without removing it, so the caller can
 * keep it until the instance has actually started (a failed start then loses
 * nothing) and call `discardBacklogSnapshot` afterwards — it is single-use, and
 * traffic shouldn't linger on disk once it's back in memory. A missing, stale
 * or unreadable file yields no exchanges rather than an error: a failed resume
 * must never stop Detour from starting.
 */
export function readBacklogSnapshot(requestedPort: number, now: number = Date.now()): CapturedExchange[] {
  try {
    return parseBacklogSnapshot(fs.readFileSync(backlogSnapshotPath(requestedPort), 'utf8'), now);
  } catch {
    return [];
  }
}
