import { describe, expect, it } from 'vitest';
import { detectInstallMethod, homebrewBinPath, homebrewBrewPath } from './installMethod';
import { buildRestartArgs, extractStartArgs } from './restartArgs';
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

describe('detectInstallMethod', () => {
  it('detects an Apple Silicon Homebrew Cellar path', () => {
    expect(detectInstallMethod('/opt/homebrew/Cellar/detour/1.6.0/libexec/detour')).toEqual({
      kind: 'homebrew',
      prefix: '/opt/homebrew',
    });
  });

  it('detects an Intel/Linuxbrew prefix', () => {
    expect(detectInstallMethod('/usr/local/Cellar/detour/1.6.0/libexec/detour')).toEqual({
      kind: 'homebrew',
      prefix: '/usr/local',
    });
    expect(detectInstallMethod('/home/linuxbrew/.linuxbrew/Cellar/detour/1.6.0/libexec/detour')).toEqual({
      kind: 'homebrew',
      prefix: '/home/linuxbrew/.linuxbrew',
    });
  });

  it('treats a source checkout or other package as unsupported', () => {
    expect(detectInstallMethod('/Users/me/Developer/Detour/bin/detour.js')).toEqual({ kind: 'unsupported' });
    expect(detectInstallMethod('/opt/homebrew/Cellar/other/1.0.0/bin/detour')).toEqual({ kind: 'unsupported' });
    expect(detectInstallMethod('')).toEqual({ kind: 'unsupported' });
  });

  it('derives the version-independent binary and brew paths from the prefix', () => {
    expect(homebrewBinPath('/opt/homebrew')).toBe('/opt/homebrew/bin/detour');
    expect(homebrewBrewPath('/opt/homebrew')).toBe('/opt/homebrew/bin/brew');
  });
});

describe('restart args', () => {
  it('drops foreground/background selectors', () => {
    expect(extractStartArgs(['--port', '8080', '--detach', '--foreground', '--rules', 'r.json'])).toEqual([
      '--port',
      '8080',
      '--rules',
      'r.json',
    ]);
  });

  it('relaunches detached without opening a browser tab', () => {
    expect(buildRestartArgs(['--port', '8080'])).toEqual(['start', '--port', '8080', '--no-open', '--detach']);
  });

  it('does not duplicate an existing --no-open', () => {
    expect(buildRestartArgs(['--no-open', '--port', '8080'])).toEqual([
      'start',
      '--no-open',
      '--port',
      '8080',
      '--detach',
    ]);
  });
});
