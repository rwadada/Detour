import type { UpdateService } from '../../domain/update/updateService';
import { detectCurrentInstall } from './currentInstall';
import { fetchLatestReleaseVersion } from './githubRelease';
import { spawnDetachedUpdater } from './spawnUpdater';
import { createUpdateService } from './updateService';

// eslint-disable-next-line @typescript-eslint/no-require-imports -- same runtime package.json read as cli.ts.
const pkg = require('../../../package.json') as { version: string };

function isOptOut(value: string | undefined): boolean {
  return !!value && value !== '0' && value.toLowerCase() !== 'false';
}

/**
 * The release check + one-click update behind the dashboard banner. Only
 * Homebrew installs get one: a source checkout has no release to compare
 * against, and `DETOUR_NO_UPDATE_CHECK=1` opts out of the network lookup.
 * `trackRunState` is false for `--port 0` runs, which `detour update` can't
 * find or relaunch, so they're told to update from a terminal instead.
 */
export function createDefaultUpdateService(trackRunState: boolean): UpdateService | undefined {
  if (isOptOut(process.env.DETOUR_NO_UPDATE_CHECK)) return undefined;
  if (detectCurrentInstall().kind !== 'homebrew') return undefined;
  return createUpdateService({
    currentVersion: pkg.version,
    canSelfUpdate: trackRunState,
    fetchLatestVersion: fetchLatestReleaseVersion,
    startUpdater: spawnDetachedUpdater,
  });
}
