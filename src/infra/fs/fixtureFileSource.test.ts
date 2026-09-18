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
    expect(() => loadFixtureFiles(dir)).toThrow(/"path" must be a string/);
  });

  it('rejects responseHeaders being an array itself, not just individual header values', () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, '00001-bad.json'), JSON.stringify({ ...sample, responseHeaders: [] }));
    expect(() => loadFixtureFiles(dir)).toThrow(/"responseHeaders" must be an object \(not an array\)/);
  });

  it('accepts a multi-value (array) response header, e.g. multiple Set-Cookie', () => {
    const dir = freshDir();
    const withMultiValue: Fixture = { ...sample, responseHeaders: { 'set-cookie': ['a=1', 'b=2'] } };
    writeFixtureFile(dir, '00001-get-x.json', withMultiValue);
    expect(loadFixtureFiles(dir)).toEqual([withMultiValue]);
  });

  it('throws a clear error for a response header value that is neither a string nor a string array', () => {
    const dir = freshDir();
    fs.writeFileSync(
      path.join(dir, '00001-bad.json'),
      JSON.stringify({ ...sample, responseHeaders: { 'x-count': 3 } }),
    );
    expect(() => loadFixtureFiles(dir)).toThrow(/"responseHeaders.x-count" must be a string or an array of strings/);
  });

  it('throws a clear error for a non-string statusMessage', () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, '00001-bad.json'), JSON.stringify({ ...sample, statusMessage: 200 }));
    expect(() => loadFixtureFiles(dir)).toThrow(/"statusMessage" must be a string/);
  });

  it('throws a clear error for an invalid responseBodyEncoding', () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, '00001-bad.json'), JSON.stringify({ ...sample, responseBodyEncoding: 'utf7' }));
    expect(() => loadFixtureFiles(dir)).toThrow(/"responseBodyEncoding" must be "base64"/);
  });

  it('throws a clear error for responseBodyEncoding set without a responseBody', () => {
    const dir = freshDir();
    const withoutBody: Partial<Fixture> = { ...sample };
    delete withoutBody.responseBody;
    fs.writeFileSync(
      path.join(dir, '00001-bad.json'),
      JSON.stringify({ ...withoutBody, responseBodyEncoding: 'base64' }),
    );
    expect(() => loadFixtureFiles(dir)).toThrow(/"responseBodyEncoding" must not be set without a "responseBody"/);
  });

  it('throws a clear error for a path missing the leading "/" (it could never match a real request)', () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, '00001-bad.json'), JSON.stringify({ ...sample, path: 'orders/1' }));
    expect(() => loadFixtureFiles(dir)).toThrow(/"path" must start with "\//);
  });

  it.each([200.5, 99, 600, -1, 0])('throws a clear error for an out-of-range or non-integer status (%s)', (status) => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, '00001-bad.json'), JSON.stringify({ ...sample, status }));
    expect(() => loadFixtureFiles(dir)).toThrow(/"status" must be an integer HTTP status code \(100-599\)/);
  });

  it('collects every validation error rather than stopping at the first', () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, '00001-bad.json'), JSON.stringify({ method: 'GET' }));
    try {
      loadFixtureFiles(dir);
      expect.unreachable();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain('"path" must be a string');
      expect(message).toContain('"status" must be an integer HTTP status code (100-599)');
      expect(message).toContain('"responseHeaders" must be an object');
    }
  });
});
