import path from 'node:path';

/** How this copy of detour was installed — decides which upgrade mechanism `detour update` can drive. */
export type InstallMethod = { kind: 'homebrew'; prefix: string } | { kind: 'unsupported' };

const CELLAR_MARKER = `${path.sep}Cellar${path.sep}detour${path.sep}`;

/**
 * Detects a Homebrew install from the entry script's *real* path (symlinks
 * resolved): Homebrew keeps each version under `<prefix>/Cellar/detour/<ver>/`
 * and symlinks the entry point into `<prefix>/bin`. Everything else (a
 * source checkout, `npm start`, a hand-extracted tarball) has no upgrade
 * mechanism detour can safely drive, so it's reported as unsupported.
 */
export function detectInstallMethod(realScriptPath: string): InstallMethod {
  const index = realScriptPath.indexOf(CELLAR_MARKER);
  if (index <= 0) return { kind: 'unsupported' };
  return { kind: 'homebrew', prefix: realScriptPath.slice(0, index) };
}

/**
 * The version-independent entry point to (re)launch after an upgrade. The
 * running process's own path points into the old `Cellar/detour/<ver>/`
 * directory, which Homebrew deletes during the upgrade — `<prefix>/bin/detour`
 * is the symlink that gets repointed at the new version.
 */
export function homebrewBinPath(prefix: string): string {
  return path.join(prefix, 'bin', 'detour');
}

export function homebrewBrewPath(prefix: string): string {
  return path.join(prefix, 'bin', 'brew');
}
