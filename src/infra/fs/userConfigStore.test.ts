import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  // Windows has no POSIX permission bits — `mode`/`chmodSync` are no-ops
  // there (see userConfigStore.ts's comments), so these only mean anything
  // on POSIX platforms (issue #96).
  describe.skipIf(process.platform === 'win32')('file permissions (POSIX only)', () => {
    it('writes config.json 0600 (owner-only) and ~/.detour 0700, since the file can hold a password hash', () => {
      writeUserConfig({ defaultDetach: true }, configPath);

      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(configPath)).mode & 0o777).toBe(0o700);
    });

    it('tightens a pre-existing config left with loose permissions (by a version predating issue #96) on the next write', () => {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({ defaultDetach: true }));
      // Deliberately loosening permissions to simulate a config.json written
      // by a version predating issue #96's fix — not a real permission mistake.
      // eslint-disable-next-line sonarjs/file-permissions -- test fixture simulating a pre-fix, world-readable config.
      fs.chmodSync(path.dirname(configPath), 0o755);
      // eslint-disable-next-line sonarjs/file-permissions -- test fixture simulating a pre-fix, world-readable config.
      fs.chmodSync(configPath, 0o644);

      writeUserConfig({ lanAccess: true }, configPath);

      expect(fs.statSync(path.dirname(configPath)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    });

    it('tightens a pre-existing world-readable config to 0600 before writing new content to it, not just after', () => {
      // Regression for a Copilot review finding on PR #104: if the chmod
      // only ran *after* writeFileSync, a pre-existing world-readable
      // config.json would sit world-readable — with this call's own new
      // content already written into it — for the window between the two
      // calls. Asserting call order (chmod, then write, then chmod again)
      // is what's actually checkable synchronously; the statSync assertions
      // above cover the end state.
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({ defaultDetach: true }));
      // eslint-disable-next-line sonarjs/file-permissions -- test fixture simulating a pre-fix, world-readable config.
      fs.chmodSync(configPath, 0o644);

      const realChmodSync = fs.chmodSync.bind(fs);
      const realWriteFileSync = fs.writeFileSync.bind(fs);
      const calls: string[] = [];
      const chmodSpy = vi.spyOn(fs, 'chmodSync').mockImplementation((target, mode) => {
        if (target === configPath) calls.push(`chmod:${mode}`);
        return realChmodSync(target, mode);
      });
      const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((target, ...rest) => {
        if (target === configPath) calls.push('write');
        return realWriteFileSync(target, ...rest);
      });

      // try/finally so a throw from writeUserConfig or the assertion itself
      // (e.g. this test failing) can't leak these spies into later tests —
      // matches dashboardServer.dashboardPassword.test.ts's own pattern.
      try {
        writeUserConfig({ dashboardPasswordHash: VALID_HASH_FIXTURE }, configPath);
        expect(calls).toEqual(['chmod:384', 'write', 'chmod:384']); // 0o600 === 384
      } finally {
        chmodSpy.mockRestore();
        writeSpy.mockRestore();
      }
    });
  });
});
