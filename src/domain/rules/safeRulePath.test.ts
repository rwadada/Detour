import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveRulePath } from './safeRulePath';

describe('resolveRulePath (issue #98)', () => {
  it('resolves a plain relative path against basePath', () => {
    expect(resolveRulePath('/base/rules', './script.js', 'script.path', false)).toBe(
      path.resolve('/base/rules', 'script.js'),
    );
  });

  it('rejects an absolute path outside basePath', () => {
    expect(() => resolveRulePath('/base/rules', '/etc/passwd', 'mock.bodyFile', false)).toThrow(/resolves outside/);
  });

  it('rejects a `../` path that escapes basePath', () => {
    expect(() => resolveRulePath('/base/rules', '../../etc/passwd', 'mock.bodyFile', false)).toThrow(
      /resolves outside/,
    );
  });

  it('includes the field label in the error message', () => {
    expect(() => resolveRulePath('/base/rules', '/etc/passwd', 'script.path', false)).toThrow(/script\.path/);
  });

  it('allows a path outside basePath when allowExternal is true', () => {
    expect(resolveRulePath('/base/rules', '/etc/passwd', 'mock.bodyFile', true)).toBe('/etc/passwd');
  });

  it('allows a path that resolves to basePath itself', () => {
    expect(resolveRulePath('/base/rules', '.', 'script.path', false)).toBe(path.resolve('/base/rules'));
  });

  it('allows a nested subdirectory path', () => {
    expect(resolveRulePath('/base/rules', 'scripts/hook.js', 'script.path', false)).toBe(
      path.resolve('/base/rules', 'scripts/hook.js'),
    );
  });

  // A path that doesn't exist on disk can't be checked for a symlink escape
  // (there's nothing to fs.realpathSync), so the lexical check above is the
  // only guard — and that's fine: the actual read/require call this feeds
  // into raises its own not-found error either way. All the fixtures above
  // use fictional paths like `/base/rules` for exactly this reason.
  describe('symlink escapes (real filesystem)', () => {
    let dir: string;
    let root: string;
    let outside: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-safe-rule-path-test-'));
      root = path.join(dir, 'rules-dir');
      outside = path.join(dir, 'outside');
      fs.mkdirSync(root);
      fs.mkdirSync(outside);
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('rejects a file symlink inside basePath that points outside it', () => {
      const target = path.join(outside, 'secret.js');
      fs.writeFileSync(target, 'module.exports = {};');
      const link = path.join(root, 'hook.js');
      fs.symlinkSync(target, link);

      expect(() => resolveRulePath(root, 'hook.js', 'script.path', false)).toThrow(/resolves \(via a symlink\)/);
    });

    it('rejects a path through a symlinked subdirectory that points outside basePath', () => {
      fs.writeFileSync(path.join(outside, 'body.json'), '{}');
      fs.symlinkSync(outside, path.join(root, 'linked-dir'));

      expect(() => resolveRulePath(root, 'linked-dir/body.json', 'mock.bodyFile', false)).toThrow(
        /resolves \(via a symlink\)/,
      );
    });

    it('allows a symlink that stays within basePath', () => {
      const target = path.join(root, 'real.js');
      fs.writeFileSync(target, 'module.exports = {};');
      const link = path.join(root, 'hook.js');
      fs.symlinkSync(target, link);

      expect(resolveRulePath(root, 'hook.js', 'script.path', false)).toBe(link);
    });

    it('allows a symlink escape when allowExternal is true', () => {
      const target = path.join(outside, 'secret.js');
      fs.writeFileSync(target, 'module.exports = {};');
      const link = path.join(root, 'hook.js');
      fs.symlinkSync(target, link);

      expect(resolveRulePath(root, 'hook.js', 'script.path', true)).toBe(link);
    });

    it('allows a real (non-symlinked) file that exists within basePath', () => {
      const target = path.join(root, 'real.js');
      fs.writeFileSync(target, 'module.exports = {};');

      expect(resolveRulePath(root, 'real.js', 'script.path', false)).toBe(target);
    });
  });
});
