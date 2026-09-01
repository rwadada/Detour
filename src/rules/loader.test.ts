import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadRulesFile } from './loader';

describe('loadRulesFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-loader-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('loads and returns a valid rules file', () => {
    const filePath = path.join(dir, 'rules.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify({ rules: [{ name: 'r1', match: { url: 'https://x/*' }, action: { type: 'route', host: 'y' } }] }),
    );
    const result = loadRulesFile(filePath);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]?.name).toBe('r1');
  });

  it('throws a descriptive error for a missing file', () => {
    expect(() => loadRulesFile(path.join(dir, 'nope.json'))).toThrow(/Could not read rules file/);
  });

  it('preserves the original fs error as `cause`', () => {
    try {
      loadRulesFile(path.join(dir, 'nope.json'));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).cause).toBeInstanceOf(Error);
    }
  });

  it('throws a descriptive error for invalid JSON', () => {
    const filePath = path.join(dir, 'broken.json');
    fs.writeFileSync(filePath, '{ not json');
    expect(() => loadRulesFile(filePath)).toThrow(/invalid JSON/);
  });

  it('throws a descriptive error for a document that fails schema validation, listing every issue', () => {
    const filePath = path.join(dir, 'invalid.json');
    fs.writeFileSync(filePath, JSON.stringify({ rules: [{ name: 'r1', match: {}, action: { type: 'bogus' } }] }));
    try {
      loadRulesFile(filePath);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toMatch(/failed validation/);
    }
  });
});
