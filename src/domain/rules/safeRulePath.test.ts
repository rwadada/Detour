import path from 'node:path';
import { describe, expect, it } from 'vitest';
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
});
