import type { RunState } from '../../domain/daemon/types';
import { isNewerVersion, normalizeVersion } from '../../domain/update/version';

/** Everything `runUpdate` needs from the outside world — real implementations live in `commands/updateCommand.ts` / `infra/update/`. */
export interface UpdateDeps {
  currentVersion: string;
  /** False when detour has no safe way to upgrade itself (not a Homebrew install). */
  canSelfUpgrade: boolean;
  /** Printed when `canSelfUpgrade` is false, telling the user how to update by hand. */
  manualUpgradeHint: string;
  fetchLatestVersion(): Promise<string>;
  listRunningInstances(): RunState[];
  /** Upgrades the installed package on disk (e.g. `brew upgrade`). Running processes keep executing the old code until they are restarted. */
  upgradePackage(): Promise<void>;
  /** Asks the *on-disk* binary for its version — after an upgrade this is the new one, unlike `currentVersion`. */
  readInstalledVersion(): Promise<string>;
  stopInstance(state: RunState): Promise<void>;
  /** Relaunches `state` as a background daemon on the freshly installed version. */
  startInstance(state: RunState): Promise<void>;
  confirm(question: string): Promise<boolean>;
  log(message: string): void;
  warn(message: string): void;
}

export interface UpdateOptions {
  /** Only report whether a newer release exists; change nothing. */
  checkOnly: boolean;
  /** Skip the confirmation prompt. */
  yes: boolean;
}

export type UpdateOutcome =
  | { kind: 'up-to-date'; version: string }
  | { kind: 'update-available'; current: string; latest: string }
  | { kind: 'cancelled' }
  | { kind: 'formula-lagging'; current: string; latest: string }
  | { kind: 'updated'; from: string; to: string; restarted: number[]; failed: number[]; notRestartable: number[] };

function describeInstance(state: RunState): string {
  return `port ${state.requestedPort} (pid ${state.pid}${state.detached ? ', background' : ', foreground'})`;
}

function announceInstances(
  deps: Pick<UpdateDeps, 'log'>,
  restartable: RunState[],
  notRestartable: RunState[],
  latest: string,
): void {
  deps.log('Running instances:');
  for (const state of restartable) deps.log(`  • ${describeInstance(state)} — will be restarted on ${latest}`);
  for (const state of notRestartable) {
    deps.log(`  • ${describeInstance(state)} — started by an older detour; must be restarted by hand`);
  }
  if (restartable.some((state) => !state.detached)) {
    deps.log('  Foreground instances are restarted in the background (their terminal session ends).');
  }
}

async function restartInstances(
  deps: Pick<UpdateDeps, 'stopInstance' | 'startInstance' | 'warn'>,
  instances: RunState[],
): Promise<{ restarted: number[]; failed: number[] }> {
  const restarted: number[] = [];
  const failed: number[] = [];
  for (const state of instances) {
    try {
      await deps.stopInstance(state);
      await deps.startInstance(state);
      restarted.push(state.requestedPort);
    } catch (err) {
      failed.push(state.requestedPort);
      deps.warn(
        `Could not restart ${describeInstance(state)}: ${err instanceof Error ? err.message : String(err)}. Start it manually with \`detour start --port ${state.requestedPort} …\`.`,
      );
    }
  }
  return { restarted, failed };
}

/** Orchestrates `detour update`: check → (confirm) → upgrade the package → restart each running instance on the new version. */
export async function runUpdate(deps: UpdateDeps, options: UpdateOptions): Promise<UpdateOutcome> {
  const current = normalizeVersion(deps.currentVersion);
  const latest = normalizeVersion(await deps.fetchLatestVersion());

  if (!isNewerVersion(latest, current)) {
    deps.log(`✔ detour ${current} is up to date.`);
    return { kind: 'up-to-date', version: current };
  }
  deps.log(`A new version is available: ${current} → ${latest}`);
  if (options.checkOnly) {
    deps.log('  Run `detour update` to install it.');
    return { kind: 'update-available', current, latest };
  }
  if (!deps.canSelfUpgrade) {
    throw new Error(deps.manualUpgradeHint);
  }

  const running = deps.listRunningInstances();
  const restartable = running.filter((state) => state.startArgs !== undefined);
  const notRestartable = running.filter((state) => state.startArgs === undefined);

  if (running.length > 0) announceInstances(deps, restartable, notRestartable, latest);
  if (!options.yes && !(await deps.confirm(`Update to ${latest}${restartable.length > 0 ? ' and restart' : ''}?`))) {
    deps.log('Cancelled.');
    return { kind: 'cancelled' };
  }

  // Upgrade before stopping anything: if the upgrade fails, running
  // instances are left exactly as they were.
  await deps.upgradePackage();
  const installed = normalizeVersion(await deps.readInstalledVersion());
  if (!isNewerVersion(installed, current)) {
    deps.warn(
      `Release ${latest} exists, but the installed version is still ${installed} — the package manager hasn't picked it up yet (a Homebrew tap bump can lag a few minutes). Try again shortly.`,
    );
    return { kind: 'formula-lagging', current, latest };
  }

  const { restarted, failed } = await restartInstances(deps, restartable);
  for (const state of notRestartable) {
    deps.warn(
      `${describeInstance(state)} is still running the old version — restart it with \`detour stop --port ${state.requestedPort}\` and \`detour start\`.`,
    );
  }

  deps.log(`✔ Updated detour ${current} → ${installed}.`);
  return {
    kind: 'updated',
    from: current,
    to: installed,
    restarted,
    failed,
    notRestartable: notRestartable.map((state) => state.requestedPort),
  };
}
