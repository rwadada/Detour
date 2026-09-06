import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadUserConfig, writeUserConfig } from './userConfigStore';

// A syntactically well-formed `dashboardPasswordHash` fixture (matches the
// exact `<32-hex-char salt>:<128-hex-char hash>` shape `hashDashboardPassword`
// produces) — content is irrelevant to `userConfigStore`, only the shape is
// validated here, so this doesn't need to be a real hash of anything.
const VALID_HASH_FIXTURE = `${'a'.repeat(32)}:${'b'.repeat(128)}`;

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

  it('writes and reads lanAccess back unchanged', () => {
    writeUserConfig({ lanAccess: true }, configPath);
    expect(loadUserConfig(configPath)).toEqual({ lanAccess: true });
  });

  it('throws when lanAccess is not a boolean', () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ lanAccess: 'yes' }));
    expect(() => loadUserConfig(configPath)).toThrow(/must be a boolean/);
  });

  it('writes and reads dashboardPasswordHash back unchanged', () => {
    writeUserConfig({ dashboardPasswordHash: VALID_HASH_FIXTURE }, configPath);
    expect(loadUserConfig(configPath)).toEqual({ dashboardPasswordHash: VALID_HASH_FIXTURE });
  });

  it('writes and reads a null dashboardPasswordHash back unchanged (clearing a previously-set password)', () => {
    writeUserConfig({ dashboardPasswordHash: VALID_HASH_FIXTURE }, configPath);
    writeUserConfig({ dashboardPasswordHash: null }, configPath);
    expect(loadUserConfig(configPath)).toEqual({ dashboardPasswordHash: null });
  });

  it('throws when dashboardPasswordHash is neither a string nor null', () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ dashboardPasswordHash: 42 }));
    expect(() => loadUserConfig(configPath)).toThrow(/must be a valid hash/);
  });

  // A real hash from `hashDashboardPassword` is never empty — this can only
  // be a hand-edit, and left unchecked would leave `dashboardPasswordSet`
  // reporting "on" while no password could ever actually verify against it.
  it('throws when dashboardPasswordHash is an empty string', () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ dashboardPasswordHash: '' }));
    expect(() => loadUserConfig(configPath)).toThrow(/must be a valid hash/);
  });

  // Same "would leave dashboardPasswordSet: true with no password ever
  // able to verify" concern as an empty string, but for a non-empty value
  // that's still the wrong shape (no colon, or the wrong hex lengths) —
  // `verifyDashboardPassword` uses the exact same shape check, so anything
  // that fails it here could never verify a password either way.
  it('throws when dashboardPasswordHash is a non-empty string with the wrong shape', () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- a malformed-shape test fixture, not a real credential.
    fs.writeFileSync(configPath, JSON.stringify({ dashboardPasswordHash: 'not-a-valid-hash' }));
    expect(() => loadUserConfig(configPath)).toThrow(/must be a valid hash/);
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

  // A `setUserConfig` WebSocket message reaches `writeUserConfig` with only a
  // compile-time `Partial<UserConfigState>` guarantee — `JSON.parse`d input
  // (a frontend bug, a hand-crafted frame, or anything else on the network
  // once `--lan` is on) can defeat that entirely. `as never` below simulates
  // exactly that: a value the type system would normally reject.
  it('rejects a malformed patch rather than writing it to disk', () => {
    expect(() => writeUserConfig({ lanAccess: 'yes' as never }, configPath)).toThrow(/must be a boolean/);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('rejects a malformed patch even when it would merge with an already-valid file', () => {
    writeUserConfig({ defaultDetach: true }, configPath);
    expect(() => writeUserConfig({ lanAccess: 'yes' as never }, configPath)).toThrow(/must be a boolean/);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({ defaultDetach: true });
  });

  // Only WRITABLE_KEYS is ever copied out of a patch — a plain
  // `{ ...existing, ...patch }` spread would instead persist whatever else
  // the patch happened to carry, including a key like `__proto__` that a
  // `setUserConfig` WebSocket message has no business writing at all.
  it('ignores keys in the patch that are not on the writable-fields whitelist', () => {
    writeUserConfig({ defaultDetach: true, notAKnownField: 'sneaky' } as never, configPath);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({ defaultDetach: true });
  });

  it("still preserves the existing file's own unknown keys (only the patch is whitelisted, not what's already on disk)", () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ somethingFromAFutureVersion: 'kept' }));

    writeUserConfig({ defaultDetach: true }, configPath);

    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({
      defaultDetach: true,
      somethingFromAFutureVersion: 'kept',
    });
  });
});
