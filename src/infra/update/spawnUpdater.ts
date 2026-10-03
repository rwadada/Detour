import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Where the detached updater's output goes — nobody is watching its terminal. */
export function updateLogPath(): string {
  return path.join(os.homedir(), '.detour', 'update.log');
}

/**
 * Launches `detour update --yes` in its own session. It has to outlive this
 * process: the first thing the update does is stop this very instance, so a
 * normal child would be taken down with it before it could restart anything.
 */
export async function spawnDetachedUpdater(onExit: (exitCode: number | null) => void): Promise<void> {
  const entry = process.argv[1];
  if (!entry) throw new Error('cannot locate the detour executable to run the updater');
  const logPath = updateLogPath();
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, 'w', 0o600);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [entry, 'update', '--yes'], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: { ...process.env, NO_COLOR: '1' },
      });
      child.once('error', reject);
      child.once('exit', (code) => onExit(code));
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
  } finally {
    fs.closeSync(logFd);
  }
}
