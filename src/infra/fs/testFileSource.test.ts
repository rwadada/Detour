import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadTestFile } from './testFileSource';

describe('loadTestFile', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  function writeFile(contents: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-test-file-'));
    const filePath = path.join(tmpDir, 'detour.test.json');
    fs.writeFileSync(filePath, contents);
    return filePath;
  }

  it('loads and returns a valid assertions file', () => {
    const filePath = writeFile(
      JSON.stringify({
        assertions: [{ type: 'latencyP95', name: 'a', match: { url: 'https://x/*' }, maxMs: 100 }],
      }),
    );
    expect(loadTestFile(filePath).assertions).toHaveLength(1);
  });

  it('throws a clear error for a missing file', () => {
    expect(() => loadTestFile(path.join(os.tmpdir(), 'does-not-exist.json'))).toThrow(
      /Could not read test assertions file/,
    );
  });

  it('throws a clear error for invalid JSON', () => {
    const filePath = writeFile('{ not json');
    expect(() => loadTestFile(filePath)).toThrow(/invalid JSON/);
  });

  it('throws a clear error for a document that fails schema validation', () => {
    const filePath = writeFile(JSON.stringify({ assertions: [{ type: 'bogus' }] }));
    expect(() => loadTestFile(filePath)).toThrow(/failed validation/);
  });
});
