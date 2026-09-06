/**
 * The device/OS kinds `detour setup`/`doctor`/`cleanup` (issue #65) know
 * how to talk about. Windows is in scope per the issue but ships manual-only
 * guidance for now (see `automation.ts`) rather than being left out — it's
 * still a valid `--target`.
 */
export const SETUP_TARGETS = ['android', 'ios', 'mac', 'linux', 'windows'] as const;

export type SetupTarget = (typeof SETUP_TARGETS)[number];

export function isSetupTarget(value: string): value is SetupTarget {
  return (SETUP_TARGETS as readonly string[]).includes(value);
}
