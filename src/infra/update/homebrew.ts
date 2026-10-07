import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { homebrewBinPath, homebrewBrewPath } from '../../domain/update/installMethod';
import { buildRestartArgs } from '../../domain/update/restartArgs';
import type { RunState } from '../../domain/daemon/types';
import { verifyDownloadBeforeUpgrade, verifyReleaseAttestation } from './attestation';

const FORMULA = 'rwadada/detour/detour';

function runInherited(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', cwd: options.cwd, env: options.env });
    child.once('error', (err) => reject(new Error(`could not run ${command}: ${err.message}`)));
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`\`${[command, ...args].join(' ')}\` exited with code ${code}`));
    });
  });
}

/** Where `brew fetch` put the download for `FORMULA` (`brew --cache <formula>`). */
function brewCachedDownloadPath(brew: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(brew, ['--cache', FORMULA], { timeout: 30_000 }, (err, stdout) => {
      if (err) reject(new Error(`could not locate the downloaded release: ${err.message}`));
      else resolve(stdout.trim());
    });
  });
}

/**
 * `brew update`, then fetch the release and check its build attestation
 * (issue #211 — see `verifyDownloadBeforeUpgrade`), then `brew upgrade`. Output
 * streams to the terminal so a long download isn't silent. A failed attestation
 * throws before anything is installed.
 */
export async function brewUpgradeDetour(
  prefix: string,
  report: { log(message: string): void; warn(message: string): void },
): Promise<void> {
  const brew = fs.existsSync(homebrewBrewPath(prefix)) ? homebrewBrewPath(prefix) : 'brew';
  await runInherited(brew, ['update']);
  await verifyDownloadBeforeUpgrade({
    fetchDownload: () => runInherited(brew, ['fetch', FORMULA]),
    cachedDownloadPath: () => brewCachedDownloadPath(brew),
    verify: (file) =>
      verifyReleaseAttestation(
        file,
        fs.existsSync(path.join(prefix, 'bin', 'gh')) ? path.join(prefix, 'bin', 'gh') : 'gh',
      ),
    ...report,
  });
  await runInherited(brew, ['upgrade', FORMULA]);
}

/** `<prefix>/bin/detour --version` — i.e. what's installed on disk right now, not what this (possibly outdated) process is running. */
export function readInstalledBrewVersion(prefix: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(homebrewBinPath(prefix), ['--version'], { timeout: 15_000 }, (err, stdout) => {
      if (err) reject(new Error(`could not read the installed detour version: ${err.message}`));
      else resolve(stdout.trim());
    });
  });
}

/** Relaunches `state` as a background daemon via the freshly upgraded `<prefix>/bin/detour`, in its original working directory. */
export function startInstanceViaBrew(prefix: string, state: RunState): Promise<void> {
  return runInherited(homebrewBinPath(prefix), buildRestartArgs(state.startArgs ?? []), {
    cwd: state.cwd,
    env: envForRelaunch(process.env),
  });
}

/**
 * The release bundle's banner sets `DETOUR_WEB_DIST_DIR` to the sibling
 * `web-dist/` of *this* (old) version — a directory the upgrade just deleted.
 * Inherited by the relaunched process it would win over the new bundle's own
 * default and leave the dashboard serving a 500, so it must not carry over.
 */
export function envForRelaunch(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const rest = { ...env };
  delete rest.DETOUR_WEB_DIST_DIR;
  return rest;
}
