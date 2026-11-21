import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createOwnerOnlyFile, tightenIfOwned, writeOwnerOnlyFile } from './ownerOnly';

const dirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-owner-only-test-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const modeOf = (p: string) => fs.statSync(p).mode & 0o777;

/** A file/directory deliberately left with a loose mode: the state the code under test must repair, or must leave alone. */
function loosen(p: string, mode: number): void {
  fs.chmodSync(p, mode);
}

describe.skipIf(process.platform === 'win32')('tightenIfOwned', () => {
  it('tightens a regular file to 0600 and a directory to 0700', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'x');
    loosen(file, 0o644);
    loosen(dir, 0o755);

    tightenIfOwned(file, 'file');
    tightenIfOwned(dir, 'directory');

    expect(modeOf(file)).toBe(0o600);
    expect(modeOf(dir)).toBe(0o700);
  });

  it('never follows a symlink, so the file or directory it points at keeps its mode', () => {
    const dir = tmpDir();
    const target = path.join(dir, 'target');
    fs.mkdirSync(target);
    loosen(target, 0o755);
    fs.symlinkSync(target, path.join(dir, 'link'));

    tightenIfOwned(path.join(dir, 'link'), 'directory');

    expect(modeOf(target)).toBe(0o755);
  });

  it('skips a missing path and a path of the other kind', () => {
    const dir = tmpDir();
    loosen(dir, 0o755);
    expect(() => tightenIfOwned(path.join(dir, 'missing'), 'file')).not.toThrow();
    tightenIfOwned(dir, 'file');
    expect(modeOf(dir)).toBe(0o755);
  });
});

describe('createOwnerOnlyFile', () => {
  it('creates a missing file (0600 on POSIX) and leaves an existing one untouched', () => {
    const file = path.join(tmpDir(), 'db');
    expect(createOwnerOnlyFile(file)).toBe(true);
    if (process.platform !== 'win32') expect(modeOf(file)).toBe(0o600);
    fs.writeFileSync(file, 'data');
    expect(createOwnerOnlyFile(file)).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('data');
  });
});

describe('writeOwnerOnlyFile', () => {
  it('replaces the file with a new one and leaves no temporary file behind', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'dump.txt');
    fs.writeFileSync(file, 'old');
    if (process.platform !== 'win32') loosen(file, 0o644);
    const oldInode = fs.statSync(file).ino;

    writeOwnerOnlyFile(file, 'new');

    expect(fs.readFileSync(file, 'utf8')).toBe('new');
    expect(fs.readdirSync(dir)).toEqual(['dump.txt']);
    if (process.platform !== 'win32') {
      expect(modeOf(file)).toBe(0o600);
      expect(fs.statSync(file).ino).not.toBe(oldInode);
    }
  });
});
