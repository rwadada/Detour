import fs from 'node:fs';

/**
 * Owner-only file helpers for files that hold decrypted traffic or secrets
 * (issue #303: the `--persist` history database and `--dump file` dumps; the
 * run state files, which carry `detour start`'s arguments). Every function
 * is a no-op for the permission part on Windows, which has no POSIX mode bits.
 *
 * The writers never let a reader see a file half-written: content goes to a
 * temporary file first and is renamed or linked into place in one step. The
 * run state files rely on that for correctness (a reader deletes a file it
 * can't parse as a crashed leftover), so keep it that way.
 */
export const OWNER_ONLY_FILE_MODE = 0o600;
export const OWNER_ONLY_DIR_MODE = 0o700;

function hasCode(err: unknown, ...codes: string[]): boolean {
  return codes.includes((err as NodeJS.ErrnoException).code ?? '');
}

/**
 * Creates `dir` (and any missing parents) 0700, and tightens it to 0700 if it
 * already existed — `mkdir`'s mode applies only to directories it creates.
 * Meant for Detour's own directories (`~/.detour` and those under it): it
 * follows a symlink, so a user who keeps `~/.detour` elsewhere gets the real
 * directory protected, and it throws when it can't (a directory owned by
 * someone else) rather than carry on with secrets in a directory others can
 * read. No-op for the permission part on Windows.
 */
export function ensureOwnerOnlyDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: OWNER_ONLY_DIR_MODE });
  if (process.platform !== 'win32') fs.chmodSync(dir, OWNER_ONLY_DIR_MODE);
}

/**
 * Tightens an existing regular file (`kind: 'file'`, to 0600) or directory
 * (`'directory'`, to 0700) at `target`. It is opened with `O_NOFOLLOW` and
 * chmodded through that descriptor, so a symlink is never followed — not even
 * one swapped in between a check and the chmod — and someone else's file it
 * points at keeps its mode. Skips, without failing: a missing path, a symlink,
 * something of the other kind, and a path owned by another user (EPERM, e.g.
 * left behind by an earlier `sudo detour start`) or unreadable to us — it
 * isn't ours to change, and refusing to start over it would be a regression.
 */
export function tightenIfOwned(target: string, kind: 'file' | 'directory'): void {
  if (process.platform === 'win32') return;
  let fd: number;
  try {
    // O_NONBLOCK: opening a FIFO planted at this path must not hang startup.
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err) {
    // ELOOP (EMLINK on some BSDs): the final component is a symlink.
    if (hasCode(err, 'ENOENT', 'ELOOP', 'EMLINK', 'EACCES')) return;
    throw err;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (kind === 'file' ? stat.isFile() : stat.isDirectory()) {
      fs.fchmodSync(fd, kind === 'file' ? OWNER_ONLY_FILE_MODE : OWNER_ONLY_DIR_MODE);
    }
  } catch (err) {
    if (!hasCode(err, 'EPERM')) throw err;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Creates `filePath` empty and 0600 if nothing is there yet (`O_EXCL`, so it
 * neither follows nor replaces an existing symlink or file). Returns whether
 * it created the file.
 */
export function createOwnerOnlyFile(filePath: string): boolean {
  try {
    fs.closeSync(fs.openSync(filePath, 'wx', OWNER_ONLY_FILE_MODE));
    return true;
  } catch (err) {
    if (hasCode(err, 'EEXIST')) return false;
    throw err;
  }
}

/**
 * Replaces `filePath` with `content` in a new 0600 file: written to a
 * temporary file next to it, then renamed over it. A fresh inode means an
 * older world-readable file (or a descriptor someone still holds on it) never
 * sees the new content, and a foreign-owned file is replaced rather than
 * written into.
 */
export function writeOwnerOnlyFile(filePath: string, content: string): void {
  const tmpPath = writeOwnerOnlyTemp(filePath, content);
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }
}

/**
 * Creates `filePath` holding `content`, 0600, only if nothing is there yet,
 * and never visible half-written: the content is written to a temporary file
 * that is then hard-linked into place, and `link` fails with `EEXIST`
 * atomically when the name is taken. Returns whether it created the file.
 * Where the filesystem has no hard links, falls back to an exclusive create
 * (`wx`), which is atomic about *who* creates the file but shows it empty
 * until written.
 */
export function publishOwnerOnlyFile(filePath: string, content: string): boolean {
  const tmpPath = writeOwnerOnlyTemp(filePath, content);
  try {
    fs.linkSync(tmpPath, filePath);
    return true;
  } catch (err) {
    if (hasCode(err, 'EEXIST')) return false;
    if (!hasCode(err, 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS')) throw err;
    try {
      fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: OWNER_ONLY_FILE_MODE, flag: 'wx' });
      return true;
    } catch (fallbackErr) {
      if (hasCode(fallbackErr, 'EEXIST')) return false;
      throw fallbackErr;
    }
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
}

/** Writes `content` to a fresh 0600 temporary file next to `filePath` and returns its path. */
function writeOwnerOnlyTemp(filePath: string, content: string): string {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  // A leftover from a crashed run (or a symlink planted there) may have any mode or target; `wx` needs it gone.
  fs.rmSync(tmpPath, { force: true });
  try {
    fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode: OWNER_ONLY_FILE_MODE, flag: 'wx' });
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }
  return tmpPath;
}
