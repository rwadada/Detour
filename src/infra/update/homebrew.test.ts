import { describe, expect, it } from 'vitest';
import { envForRelaunch } from './homebrew';

describe('envForRelaunch', () => {
  it('drops the old bundle’s web-dist override so the new version uses its own', () => {
    const env = envForRelaunch({
      PATH: '/usr/bin',
      DETOUR_WEB_DIST_DIR: '/opt/homebrew/Cellar/detour/1.0.0/libexec/web-dist',
    });
    expect(env).toEqual({ PATH: '/usr/bin' });
  });

  it('leaves everything else untouched', () => {
    expect(envForRelaunch({ HOME: '/h', FOO: 'bar' })).toEqual({ HOME: '/h', FOO: 'bar' });
  });
});
