import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadUserConfig, writeUserConfig } from './userConfigStore';

describe('userConfigStore (fs-backed)', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-config-test-'));
    configPath = path.join(dir, '.detour', 'config.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns {} when the config file has never been written', () => {
    expect(loadUserConfig(configPath)).toEqual({});
  });

  it('writes and reads defaultDetach back unchanged', () => {
    writeUserConfig({ defaultDetach: true }, configPath);
    expect(loadUserConfig(configPath)).toEqual({ defaultDetach: true });
  });

  it('creates ~/.detour itself on first write', () => {
    expect(fs.existsSync(path.dirname(configPath))).toBe(false);
    writeUserConfig({ defaultDetach: true }, configPath);
    expect(fs.existsSync(configPath)).toBe(true);
  });

  it('merges a later write instead of clobbering unrelated keys', () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ defaultDetach: true, somethingElse: 'kept' }));

    writeUserConfig({ defaultDetach: false }, configPath);

    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({
      defaultDetach: false,
      somethingElse: 'kept',
    });
  });

  it('throws on invalid JSON rather than silently ignoring it', () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '{ not json');
    expect(() => loadUserConfig(configPath)).toThrow(/not valid JSON/);
  });

  it('throws when defaultDetach is not a boolean', () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ defaultDetach: 'yes' }));
    expect(() => loadUserConfig(configPath)).toThrow(/must be a boolean/);
  });

  it('throws when the file is not a JSON object', () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify([1, 2, 3]));
    expect(() => loadUserConfig(configPath)).toThrow(/must contain a JSON object/);
  });
});
