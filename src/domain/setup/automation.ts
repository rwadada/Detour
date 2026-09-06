import type { SetupTarget } from './targets';

/**
 * What `detour setup`/`doctor`/`cleanup` can actually *do* for each target,
 * as opposed to merely explain (issue #65). Kept as one small lookup table
 * rather than scattered `if (target === ...)` checks, so the CLI layer and
 * the per-target usecases agree on the same facts:
 *
 * - `hostPlatform`: for a target that *is* the machine `detour` runs on
 *   (mac/linux/windows), the `process.platform` it requires — running
 *   `detour setup --target mac` from Linux can't configure a Mac that isn't
 *   there. `undefined` means the target is a separate device reached over a
 *   tool (`adb` for android; nothing yet for ios), so no host check applies.
 * - `automated`: whether real automation is implemented at all. `false`
 *   (currently just windows) means `setup`/`doctor`/`cleanup` fall back to
 *   printing manual instructions rather than silently doing nothing —
 *   automating it needs a Windows-only follow-up, out of scope for this
 *   pass. `ios` is `true` but partial: `usecase/setup/ios.ts` automates a
 *   booted Simulator (`xcrun simctl keychain ... add-root-cert`) and still
 *   falls back to manual steps for a physical device, since Apple's device
 *   CLI (`devicectl`) has no equivalent for one — there's no MDM-free way
 *   to trust a cert or set a Wi-Fi proxy on real iOS hardware.
 */
export interface TargetAutomation {
  hostPlatform: NodeJS.Platform | undefined;
  automated: boolean;
}

export const TARGET_AUTOMATION: Record<SetupTarget, TargetAutomation> = {
  mac: { hostPlatform: 'darwin', automated: true },
  linux: { hostPlatform: 'linux', automated: true },
  windows: { hostPlatform: 'win32', automated: false },
  android: { hostPlatform: undefined, automated: true },
  ios: { hostPlatform: undefined, automated: true },
};

/** Whether `detour` is currently running on the machine `target` refers to — meaningless (and not checked) for device targets like android/ios. */
export function hostPlatformMatches(target: SetupTarget, platform: NodeJS.Platform): boolean {
  const required = TARGET_AUTOMATION[target].hostPlatform;
  return required === undefined || required === platform;
}
