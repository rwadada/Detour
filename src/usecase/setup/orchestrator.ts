import { hostPlatformMatches, TARGET_AUTOMATION } from '../../domain/setup/automation';
import { SETUP_TARGETS } from '../../domain/setup/targets';
import type { SetupTarget } from '../../domain/setup/targets';
import type { CertPairingServer } from '../ports/certPairingServer';
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
  certPairingServer: CertPairingServer;
  hostPlatform: NodeJS.Platform;
  detectedLanAddresses: string[];
  /** Whether this run targets exactly one explicit `--target` — see `SetupContext.explicitTarget`'s doc comment. `cli.ts` sets this from `options.target !== undefined`, the same condition that decides whether `runTargets` gets a one-element `targets` array or `undefined`. */
  explicitTarget: boolean;
  /** See `SetupContext.onProgress`'s doc comment. */
  onProgress?: SetupContext['onProgress'];
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
    // Two exemptions from needing a resolvable address up front:
    //
    // - `ios`, in every mode: its real automation (trusting the CA cert on
    //   a booted Simulator via `xcrun simctl`) never reads `ctx.proxyHost`
    //   at all — the Simulator shares this Mac's own network, no explicit
    //   proxy value needed. Only the physical-device manual instructions
    //   `ios.ts` always also prints use it, and those degrade gracefully
    //   (see `ios.ts`'s `physicalDeviceSteps`) instead of the whole target
    //   failing just because this machine has no LAN interface right now.
    // - `android`'s `cleanup` specifically: `runAndroidCleanup` resets the
    //   device's proxy to a fixed `:0`, never reading `ctx.proxyHost`
    //   either, and (being fully automated) never falls back to
    //   `manualSteps` — unlike android's `setup`/`doctor`, which do need a
    //   real address to configure/verify the device's proxy.
    if (target !== 'ios' && !(mode === 'cleanup' && target === 'android')) {
      return { steps: [{ status: 'failed', message: err instanceof Error ? err.message : String(err) }] };
    }
    proxyHost = inputs.hostOverride ?? '';
  }
  const instructionCtx = { certPath: inputs.certPath, proxyHost, proxyPort: inputs.proxyPort };

  if (!automation.automated) {
    return { steps: manualSteps(mode, target, instructionCtx) };
  }

  // A `--target`-less `setup` sweep announces every target rather than
  // acting on all of them at once — `doctor` (read-only) and `cleanup`
  // (only ever reverts what setup applied) don't need this guard, but
  // `setup` actually pushes certs, rewrites this machine's own proxy
  // settings, etc., and a plain `detour setup` used to do that to every
  // automated target it could reach (this machine's own network proxy
  // included) with no per-target confirmation. Naming one target with
  // `--target` (`inputs.explicitTarget`) opts back into real automation.
  if (mode === 'setup' && !inputs.explicitTarget) {
    return {
      steps: [
        { status: 'manual', message: `Run \`detour setup --target ${target}\` to set this up automatically.` },
        ...manualSteps(mode, target, instructionCtx),
      ],
    };
  }

  // ios has no `hostPlatform` requirement (Simulator automation runs
  // through locally-installed Xcode tooling, not a remote host), so this
  // only ever turns away mac/linux/windows on the wrong machine.
  if (!hostPlatformMatches(target, inputs.hostPlatform)) {
    return {
      steps: [
        {
          status: 'skipped',
          message: `This machine is running "${inputs.hostPlatform}", not "${automation.hostPlatform}" — can't run automated ${mode} for ${target} from here.`,
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
    certPairingServer: inputs.certPairingServer,
    hostPlatform: inputs.hostPlatform,
    explicitTarget: inputs.explicitTarget,
    onProgress: inputs.onProgress,
  };
  return isAutomatedTarget(target)
    ? AUTOMATED_RUNNERS[target][mode](ctx)
    : { steps: manualSteps(mode, target, instructionCtx) };
}

/**
 * Runs `mode` against every one of `targets` (or, when omitted — the
 * `detour setup`/`doctor`/`cleanup` no-`--target` behavior — every
 * `SETUP_TARGETS` entry whose `hostPlatformMatches` this machine) and
 * reports each independently. The filter only ever excludes mac/linux/
 * windows (android/ios have no `hostPlatform` requirement — see
 * `hostPlatformMatches`'s doc comment — so they're never filtered out):
 * without it, a plain `detour doctor`/`cleanup` on a Mac printed a full page
 * of Windows `certmgr.msc` steps and Linux `update-ca-certificates` steps
 * right alongside the ones that actually apply here, none of which this
 * machine could act on anyway. (`setup` gets the same benefit from this
 * filter, but for it the bigger source of that same noise is
 * `runForTarget`'s own `explicitTarget` guard — see the inline comment
 * above its `mode === 'setup' && !inputs.explicitTarget` check — which
 * this filter doesn't affect at all.) Naming a target explicitly with
 * `--target` bypasses the filter entirely (`runForTarget` still reports it
 * "skipped" with manual steps, same as ever) — this only trims the
 * *default* sweep.
 *
 * Targets share no state (each gets its own `CommandRunner` calls against a
 * different tool/device), so they run concurrently rather than one after
 * another — otherwise a plain `detour doctor` would serialize every
 * target's worth of subprocess round-trips end to end. `Promise.all`
 * preserves `list`'s order in the result regardless of which resolves
 * first.
 */
export async function runTargets(
  mode: SetupMode,
  targets: SetupTarget[] | undefined,
  inputs: OrchestratorInputs,
): Promise<TargetReport[]> {
  const list = targets ?? SETUP_TARGETS.filter((target) => hostPlatformMatches(target, inputs.hostPlatform));
  return Promise.all(list.map(async (target) => ({ target, outcome: await runForTarget(mode, target, inputs) })));
}
