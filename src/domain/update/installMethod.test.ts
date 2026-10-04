import { describe, expect, it } from 'vitest';
import { detectInstallMethod, homebrewBinPath, homebrewBrewPath } from './installMethod';

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
