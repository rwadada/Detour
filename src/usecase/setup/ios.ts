import { manualSteps } from './manualSteps';
import type { SetupContext, SetupMode, SetupStep, TargetOutcome } from './types';

interface SimctlDevice {
  udid: string;
  name: string;
  state: string;
}

/**
 * Parses `xcrun simctl list devices -j`'s shape — an object keyed by
 * runtime identifier (e.g. `com.apple.CoreSimulator.SimRuntime.iOS-18-6`),
 * each holding an array of device records — into a flat list. Tolerant of
 * anything unparseable (no Xcode installed, an unexpected future format):
 * returns no devices rather than throwing, since a `catch` up the call
 * chain would otherwise turn "Xcode isn't installed" into a less useful
 * JSON-parse error.
 */
export function parseSimulators(stdout: string): SimctlDevice[] {
  try {
    const parsed = JSON.parse(stdout) as { devices?: Record<string, SimctlDevice[]> };
    return Object.values(parsed.devices ?? {}).flat();
  } catch {
    return [];
  }
}

async function bootedSimulators(ctx: SetupContext): Promise<SimctlDevice[]> {
  const { stdout } = await ctx.runner.run('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']);
  return parseSimulators(stdout).filter((device) => device.state === 'Booted');
}

/**
 * A physical iOS device has no CLI equivalent to `simctl keychain`/proxy
 * config — Apple's own device-automation tool, `devicectl` (Xcode 15+),
 * only installs/uninstalls apps and copies files (verified against
 * `devicectl device install --help`, which lists just `app`); nothing
 * touches trust settings or Wi-Fi. So a real device always falls back to
 * the manual AirDrop-and-Settings steps, in every mode.
 */
function physicalDeviceSteps(mode: SetupMode, ctx: SetupContext): SetupStep[] {
  return manualSteps(mode, 'ios', { certPath: ctx.certPath, proxyHost: ctx.proxyHost, proxyPort: ctx.proxyPort });
}

export async function runIosSetup(ctx: SetupContext): Promise<TargetOutcome> {
  const steps: SetupStep[] = [];
  try {
    const booted = await bootedSimulators(ctx);
    if (booted.length === 0) {
      steps.push({
        status: 'skipped',
        message:
          'No booted iOS Simulator found (`xcrun simctl list devices booted`) — boot one to trust the CA cert there automatically.',
      });
    }
    for (const device of booted) {
      try {
        await ctx.runner.run('xcrun', ['simctl', 'keychain', device.udid, 'add-root-cert', ctx.certPath]);
        steps.push({ status: 'done', message: `Trusted the CA cert in the "${device.name}" Simulator's keychain.` });
      } catch (err) {
        steps.push({
          status: 'failed',
          message: `Couldn't trust the CA cert on "${device.name}": ${errorMessage(err)}`,
        });
      }
    }
    if (booted.length > 0) {
      steps.push({
        status: 'manual',
        message:
          "The Simulator shares this Mac's network stack, so its proxy follows whatever `detour setup --target mac` configures here — there's no separate proxy step for it.",
      });
    }
  } catch (err) {
    steps.push({
      status: 'failed',
      message: `Couldn't list Simulators (\`xcrun simctl\`, needs Xcode): ${errorMessage(err)}`,
    });
  }
  steps.push(...physicalDeviceSteps('setup', ctx));
  return { steps };
}

export async function runIosDoctor(ctx: SetupContext): Promise<TargetOutcome> {
  const steps: SetupStep[] = [];
  try {
    const booted = await bootedSimulators(ctx);
    steps.push(
      booted.length > 0
        ? {
            status: 'done',
            message: `${booted.length} booted Simulator(s) found (\`simctl keychain\` has no query action, so this only confirms one exists — it can't confirm the cert is actually trusted there).`,
          }
        : { status: 'skipped', message: 'No booted iOS Simulator found.' },
    );
  } catch (err) {
    steps.push({ status: 'failed', message: `Couldn't list Simulators: ${errorMessage(err)}` });
  }
  steps.push(...physicalDeviceSteps('doctor', ctx));
  return { steps };
}

export async function runIosCleanup(ctx: SetupContext): Promise<TargetOutcome> {
  // `simctl keychain <udid> reset` wipes the *entire* Simulator keychain —
  // every cert and saved password, not just ours — so it's too destructive
  // to run automatically. `setup` above never gave the Simulator a proxy of
  // its own to undo either (it inherits the Mac's), so there's nothing safe
  // to automate here.
  return { steps: physicalDeviceSteps('cleanup', ctx) };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
