import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listRuleProfiles, readRuleProfile, writeRuleProfile } from './ruleProfileStore';

const validRules = {
  rules: [{ name: 'r1', match: { url: 'https://x/*' }, action: { type: 'route' as const, host: 'y' } }],
};

describe('ruleProfileStore (fs-backed)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-profiles-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes and reads a profile back unchanged', () => {
    writeRuleProfile('staging', validRules, dir);
    expect(readRuleProfile('staging', dir)).toEqual(validRules);
  });

  it('list() is empty for a fresh directory', () => {
    expect(listRuleProfiles(dir)).toEqual([]);
  });

  it('list() summarizes every saved profile, sorted by name', () => {
    writeRuleProfile('zeta', validRules, dir);
    writeRuleProfile('alpha', { rules: [] }, dir);

    const profiles = listRuleProfiles(dir);
    expect(profiles.map((p) => p.name)).toEqual(['alpha', 'zeta']);
    expect(profiles.find((p) => p.name === 'zeta')?.ruleCount).toBe(1);
    expect(profiles.find((p) => p.name === 'alpha')?.ruleCount).toBe(0);
  });

  it('write() throws (without writing) for rules that fail validation', () => {
    expect(() =>
      writeRuleProfile('bad', { rules: [{ name: 'x', match: {}, action: { type: 'bogus' as never } }] }, dir),
    ).toThrow(/failed validation/);
    expect(fs.existsSync(path.join(dir, 'bad.json'))).toBe(false);
  });

  it('write() rejects a name outside the allowed pattern (no path traversal)', () => {
    expect(() => writeRuleProfile('../escape', validRules, dir)).toThrow(/Invalid profile name/);
    expect(() => writeRuleProfile('', validRules, dir)).toThrow(/Invalid profile name/);
  });

  it('read() throws a descriptive error for a profile that does not exist', () => {
    expect(() => readRuleProfile('missing', dir)).toThrow(/Could not read rule profile "missing"/);
  });

  it('write() overwrites an existing profile rather than appending', () => {
    writeRuleProfile('staging', validRules, dir);
    writeRuleProfile('staging', { rules: [] }, dir);
    expect(readRuleProfile('staging', dir).rules).toEqual([]);
  });
});
