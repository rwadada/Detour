import { hostPlatformMatches, TARGET_AUTOMATION } from '../../domain/setup/automation';
import { SETUP_TARGETS } from '../../domain/setup/targets';
import type { SetupTarget } from '../../domain/setup/targets';
import type { CommandRunner } from '../ports/commandRunner';
import { runAndroidCleanup, runAndroidDoctor, runAndroidSetup } from './android';
import { runIosCleanup, runIosDoctor, runIosSetup } from './ios';
import { runLinuxCleanup, runLinuxDoctor, runLinuxSetup } from './linux';
import { runMacCleanup, runMacDoctor, runMacSetup } from './mac';
import { manualSteps } from './manualSteps';
import { resolveProxyHost } from './proxyAddress';
import type { SetupContext, SetupMode, TargetOutcome } from './types';

export type { SetupMode } from './types';

/** Everything `runTargets` needs — assembled by `cli.ts` from options and OS facts (`ensureCaCert()`, `lanAddresses()`, `process.platform`), kept separate from `SetupContext` because a `proxyHost` isn't known yet until `resolveProxyHost` runs per target. */
export interface OrchestratorInputs {
  hostOverride?: string;
  certPath: string;
  proxyPort: number;
  runner: CommandRunner;
  hostPlatform: NodeJS.Platform;
  detectedLanAddresses: string[];
}

export interface TargetReport {
  target: SetupTarget;
  outcome: TargetOutcome;
}

type AutomatedTarget = 'mac' | 'android' | 'linux' | 'ios';

const AUTOMATED_RUNNERS: Record<AutomatedTarget, Record<SetupMode, (ctx: SetupContext) => Promise<TargetOutcome>>> = {
  mac: { setup: runMacSetup, doctor: runMacDoctor, cleanup: runMacCleanup },
  android: { setup: runAndroidSetup, doctor: runAndroidDoctor, cleanup: runAndroidCleanup },
  linux: { setup: runLinuxSetup, doctor: runLinuxDoctor, cleanup: runLinuxCleanup },
  ios: { setup: runIosSetup, doctor: runIosDoctor, cleanup: runIosCleanup },
};

function isAutomatedTarget(target: SetupTarget): target is AutomatedTarget {
  return target === 'mac' || target === 'android' || target === 'linux' || target === 'ios';
}

/**
 * Runs one `mode` (setup/doctor/cleanup) against one `target`. Never
 * throws for an expected condition (wrong host platform, no LAN IP to
 * advise an Android device to connect to, a missing tool) — those come
 * back as a `'skipped'`/`'failed'` step instead, so a caller iterating
 * every target (the `--target`-less case) can't have one target's
 * unavailability abort the rest.
 */
export async function runForTarget(
  mode: SetupMode,
  target: SetupTarget,
  inputs: OrchestratorInputs,
): Promise<TargetOutcome> {
  const automation = TARGET_AUTOMATION[target];

  let proxyHost: string;
  try {
    proxyHost = resolveProxyHost({
      target,
      hostOverride: inputs.hostOverride,
      detectedLanAddresses: inputs.detectedLanAddresses,
    });
  } catch (err) {
    return { steps: [{ status: 'failed', message: err instanceof Error ? err.message : String(err) }] };
  }
  const instructionCtx = { certPath: inputs.certPath, proxyHost, proxyPort: inputs.proxyPort };

  if (!automation.automated) {
    return { steps: manualSteps(mode, target, instructionCtx) };
  }

  // ios has no `hostPlatform` requirement (Simulator automation runs
  // through locally-installed Xcode tooling, not a remote host), so this
  // only ever turns away mac/linux/windows on the wrong machine.
  if (!hostPlatformMatches(target, inputs.hostPlatform)) {
    return {
      steps: [
        {
          status: 'skipped',
          message: `This machine is running "${inputs.hostPlatform}", not "${automation.hostPlatform}" — can't automate ${target} setup from here.`,
        },
        ...manualSteps(mode, target, instructionCtx),
      ],
    };
  }

  const ctx: SetupContext = {
    certPath: inputs.certPath,
    proxyHost,
    proxyPort: inputs.proxyPort,
    runner: inputs.runner,
    hostPlatform: inputs.hostPlatform,
  };
  return isAutomatedTarget(target)
    ? AUTOMATED_RUNNERS[target][mode](ctx)
    : { steps: manualSteps(mode, target, instructionCtx) };
}

/** Runs `mode` against every one of `targets` (or all five, in `SETUP_TARGETS` order, when omitted — the `detour setup`/`doctor`/`cleanup` no-`--target` behavior) and reports each independently. */
export async function runTargets(
  mode: SetupMode,
  targets: SetupTarget[] | undefined,
  inputs: OrchestratorInputs,
): Promise<TargetReport[]> {
  const list = targets ?? [...SETUP_TARGETS];
  const reports: TargetReport[] = [];
  for (const target of list) {
    reports.push({ target, outcome: await runForTarget(mode, target, inputs) });
  }
  return reports;
}
