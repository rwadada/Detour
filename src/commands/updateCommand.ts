import readline from 'node:readline/promises';
import type { Command } from 'commander';
import { listLiveRunStates } from '../infra/fs/runStateStore';
import { stopInstance } from '../infra/process/stopInstance';
import { detectCurrentInstall } from '../infra/update/currentInstall';
import { fetchLatestReleaseVersion } from '../infra/update/githubRelease';
import { brewUpgradeDetour, readInstalledBrewVersion, startInstanceViaBrew } from '../infra/update/homebrew';
import { runUpdate, type UpdateDeps } from '../usecase/update/runUpdate';

const MANUAL_UPGRADE_HINT =
  'This copy of detour was not installed with Homebrew, so it cannot update itself. ' +
  'Install with `brew tap rwadada/detour && brew install detour`, or update your source checkout (git pull && npm install && npm run build) and restart.';

async function confirmOnTty(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new Error('Confirmation needed but stdin is not a terminal — re-run with --yes to proceed.');
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

// eslint-disable-next-line @typescript-eslint/no-require-imports -- same runtime package.json read as cli.ts.
const pkg = require('../../package.json') as { version: string };

function buildDeps(): UpdateDeps {
  const install = detectCurrentInstall();
  const prefix = install.kind === 'homebrew' ? install.prefix : '';
  return {
    currentVersion: pkg.version,
    canSelfUpgrade: install.kind === 'homebrew',
    manualUpgradeHint: MANUAL_UPGRADE_HINT,
    fetchLatestVersion: fetchLatestReleaseVersion,
    listRunningInstances: listLiveRunStates,
    upgradePackage: () =>
      brewUpgradeDetour(prefix, {
        log: (message) => console.log(message),
        warn: (message) => console.warn(`⚠ ${message}`),
      }),
    readInstalledVersion: () => readInstalledBrewVersion(prefix),
    stopInstance: (state) => stopInstance(state),
    startInstance: (state) => startInstanceViaBrew(prefix, state),
    confirm: confirmOnTty,
    log: (message) => console.log(message),
    warn: (message) => console.warn(`⚠ ${message}`),
  };
}

/** Wires `detour update` into the CLI. */
export function registerUpdateCommand(program: Command): void {
  program
    .command('update')
    .description(
      'Upgrades detour to the latest release and restarts any running instances on the new version (Homebrew installs). Running `brew upgrade` yourself while detour is running leaves the old process pointing at files that no longer exist.',
    )
    .option('--check', 'Only report whether a newer release exists; change nothing')
    .option('-y, --yes', 'Do not ask for confirmation before upgrading and restarting')
    .action(async (options: { check?: boolean; yes?: boolean }) => {
      try {
        const outcome = await runUpdate(buildDeps(), { checkOnly: options.check ?? false, yes: options.yes ?? false });
        if (outcome.kind === 'updated' && outcome.failed.length > 0) process.exitCode = 1;
        if (outcome.kind === 'formula-lagging') process.exitCode = 1;
      } catch (err) {
        console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });
}
