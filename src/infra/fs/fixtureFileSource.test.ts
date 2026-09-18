import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Fixture } from '../../domain/record/types';
import { loadFixtureFiles, writeFixtureFile } from './fixtureFileSource';

describe('writeFixtureFile / loadFixtureFiles', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  function freshDir(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-fixtures-'));
    return tmpDir;
  }

  const sample: Fixture = {
    method: 'GET',
    path: '/orders/1',
    status: 200,
    responseHeaders: { 'content-type': 'application/json' },
    responseBody: '{"id":1}',
  };

  it('round-trips a written fixture back through loadFixtureFiles', () => {
    const dir = freshDir();
    writeFixtureFile(dir, '00001-get-orders-1.json', sample);
    expect(loadFixtureFiles(dir)).toEqual([sample]);
  });

  it('creates the directory if it does not exist yet', () => {
    const dir = path.join(freshDir(), 'nested', 'fixtures');
    writeFixtureFile(dir, '00001-get-x.json', sample);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('loads fixtures sorted by filename (recording order via the zero-padded sequence prefix)', () => {
    const dir = freshDir();
    writeFixtureFile(dir, '00002-get-poll.json', { ...sample, responseBody: '"second"' });
    writeFixtureFile(dir, '00001-get-poll.json', { ...sample, responseBody: '"first"' });
    const loaded = loadFixtureFiles(dir);
    expect(loaded.map((f) => f.responseBody)).toEqual(['"first"', '"second"']);
  });

  it('ignores non-JSON files in the directory', () => {
    const dir = freshDir();
    writeFixtureFile(dir, '00001-get-x.json', sample);
    fs.writeFileSync(path.join(dir, 'README.md'), '# not a fixture');
    expect(loadFixtureFiles(dir)).toHaveLength(1);
  });

  it('throws a clear error for a missing directory', () => {
    expect(() => loadFixtureFiles(path.join(os.tmpdir(), 'does-not-exist-dir'))).toThrow(
      /Could not read fixtures directory/,
    );
  });

  it('throws a clear error for invalid JSON in a fixture file', () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, '00001-bad.json'), '{ not json');
    expect(() => loadFixtureFiles(dir)).toThrow(/invalid JSON/);
  });

  it('throws a clear error for a fixture file missing required fields', () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, '00001-bad.json'), JSON.stringify({ method: 'GET' }));
    expect(() => loadFixtureFiles(dir)).toThrow(/missing one of the required fields/);
  });
});
