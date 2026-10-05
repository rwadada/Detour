import { describe, expect, it } from 'vitest';
import { type FindInstalledPwaDeps, findInstalledPwaApp } from './findInstalledPwa';

function fakeDeps(layout: Record<string, Record<string, string | Error>>): FindInstalledPwaDeps {
  return {
    home: '/Users/me',
    listDir: (dir) => {
      const apps = layout[dir];
      if (!apps) throw new Error('ENOENT');
      return Object.keys(apps);
    },
    readShortcutUrl: (appPath) => {
      const idx = appPath.lastIndexOf('/');
      const apps = layout[appPath.slice(0, idx)];
      const value = apps?.[appPath.slice(idx + 1)];
      if (value instanceof Error) throw value;
      return value === '' ? undefined : value;
    },
  };
}

describe('findInstalledPwaApp', () => {
  it('returns the app whose install URL is on the dashboard origin', () => {
    const deps = fakeDeps({
      '/Users/me/Applications/Chrome Apps.localized': {
        'Postman.app': '',
        'Detour Dashboard.app': 'http://localhost:9080/',
      },
    });
    expect(findInstalledPwaApp('http://localhost:9080', deps)).toBe(
      '/Users/me/Applications/Chrome Apps.localized/Detour Dashboard.app',
    );
  });

  it('does not match a different port or scheme', () => {
    const deps = fakeDeps({
      '/Users/me/Applications/Chrome Apps.localized': { 'Detour Dashboard.app': 'http://localhost:9080/' },
    });
    expect(findInstalledPwaApp('http://localhost:9081', deps)).toBeUndefined();
    expect(findInstalledPwaApp('https://localhost:9080', deps)).toBeUndefined();
  });

  it('also finds PWAs installed through other Chromium browsers', () => {
    const deps = fakeDeps({
      '/Users/me/Applications/Edge Apps.localized': { 'Detour Dashboard.app': 'http://localhost:9080/' },
    });
    expect(findInstalledPwaApp('http://localhost:9080', deps)).toBe(
      '/Users/me/Applications/Edge Apps.localized/Detour Dashboard.app',
    );
  });

  it('skips non-.app entries and unreadable or malformed shims', () => {
    const deps = fakeDeps({
      '/Users/me/Applications/Chrome Apps.localized': {
        Icon: 'http://localhost:9080/',
        'Broken.app': new Error('bad plist'),
        'Garbage.app': 'not a url',
      },
    });
    expect(findInstalledPwaApp('http://localhost:9080', deps)).toBeUndefined();
  });

  it('returns undefined when no PWA folder exists or the URL is invalid', () => {
    expect(findInstalledPwaApp('http://localhost:9080', fakeDeps({}))).toBeUndefined();
    expect(findInstalledPwaApp('nonsense', fakeDeps({}))).toBeUndefined();
  });
});
