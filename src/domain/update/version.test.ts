import { describe, expect, it } from 'vitest';
import { isNewerVersion, normalizeVersion, parseVersion } from './version';

describe('version', () => {
  it('parses plain, v-prefixed and pre-release versions', () => {
    expect(parseVersion('1.6.1')).toEqual([1, 6, 1]);
    expect(parseVersion('v2.0.10')).toEqual([2, 0, 10]);
    expect(parseVersion('1.7.0-rc.1')).toEqual([1, 7, 0]);
    expect(parseVersion('latest')).toBeUndefined();
  });

  it('normalizes the tag prefix', () => {
    expect(normalizeVersion(' v1.6.1\n')).toBe('1.6.1');
  });

  it('compares numerically, not lexically', () => {
    expect(isNewerVersion('1.10.0', '1.9.9')).toBe(true);
    expect(isNewerVersion('2.0.0', '1.99.99')).toBe(true);
    expect(isNewerVersion('1.6.1', '1.6.1')).toBe(false);
    expect(isNewerVersion('1.6.0', '1.6.1')).toBe(false);
  });

  it('never calls an unparseable version newer', () => {
    expect(isNewerVersion('nightly', '1.0.0')).toBe(false);
    expect(isNewerVersion('1.0.0', 'dev')).toBe(false);
  });
});
