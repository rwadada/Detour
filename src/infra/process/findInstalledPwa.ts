import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Per-browser folders where Chromium-based browsers drop the `.app` shims for installed PWAs on macOS. */
const PWA_APP_DIR_NAMES = [
  'Chrome Apps.localized',
  'Chrome Canary Apps.localized',
  'Edge Apps.localized',
  'Brave Browser Apps.localized',
  'Chromium Apps.localized',
];

export interface FindInstalledPwaDeps {
  home: string;
  listDir: (dir: string) => string[];
  readShortcutUrl: (appPath: string) => string | undefined;
}

const defaultDeps: FindInstalledPwaDeps = {
  home: homedir(),
  listDir: (dir) => readdirSync(dir),
  readShortcutUrl: (appPath) => {
    const plist = join(appPath, 'Contents', 'Info.plist');
    const json = execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const value: unknown = (JSON.parse(json) as Record<string, unknown>).CrAppModeShortcutURL;
    return typeof value === 'string' ? value : undefined;
  },
};

/**
 * macOS only: finds the `.app` shim of an installed PWA (Chrome / Edge /
 * Brave / Chromium) whose install URL is on the same origin as `url`, so the
 * dashboard can open in its standalone window instead of a browser tab.
 *
 * The shim's `Info.plist` records the install URL in `CrAppModeShortcutURL`.
 * A PWA belongs to one origin — port and scheme included — so a dashboard on
 * a different port than the one the PWA was installed from is (correctly) not
 * matched. Any failure (missing folder, unreadable plist) means "not found":
 * the caller falls back to the default browser.
 */
export function findInstalledPwaApp(url: string, deps: FindInstalledPwaDeps = defaultDeps): string | undefined {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return undefined;
  }
  for (const dirName of PWA_APP_DIR_NAMES) {
    const dir = join(deps.home, 'Applications', dirName);
    let entries: string[];
    try {
      entries = deps.listDir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.app')) continue;
      const appPath = join(dir, entry);
      try {
        const shortcutUrl = deps.readShortcutUrl(appPath);
        if (shortcutUrl && new URL(shortcutUrl).origin === origin) return appPath;
      } catch {
        // Unreadable or malformed shim — skip it.
      }
    }
  }
  return undefined;
}
