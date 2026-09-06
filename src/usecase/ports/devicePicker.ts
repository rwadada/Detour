/** One selectable `adb` device, described for a human choosing between several. */
export interface DeviceChoice {
  serial: string;
  /** One-line description shown in the selection prompt — kind (emulator/real device), connection (USB/Wi-Fi), and any diagnostic warning (e.g. "mobile data, not Wi-Fi, is this device's active network right now — the proxy setting won't reach it"). Plain text; `usecase` builds it so `infra`'s picker implementations don't need their own opinion on what's worth surfacing. */
  label: string;
}

/**
 * Prompts a human to choose one of several connected `adb` devices —
 * `android.ts`'s `requireOneDevice` falls back to this when more than one is
 * connected, instead of failing outright (its pre-existing "make the user
 * pick" stance, now actually letting them). Its own seam (rather than
 * reading `process.stdin` directly from `android.ts`) so the per-target
 * usecase can be unit tested against a fake instead of a real terminal.
 */
export interface DevicePicker {
  /**
   * Whether this environment can actually prompt anyone right now — never
   * true for a non-interactive stdin (CI, a script, a piped invocation:
   * nothing there could ever answer), and a real implementation should
   * check its output side too, not just its input (see
   * `readlineDevicePicker`'s own doc comment for why stdin alone isn't
   * enough). `android.ts`'s `requireOneDevice` checks this *before*
   * building each device's `DeviceChoice` (which costs an extra `adb shell
   * dumpsys connectivity` round trip per device — see
   * `describeDeviceChoice`), so a non-interactive run skips that work
   * entirely rather than paying for diagnostics nobody will ever see
   * before falling back to its original fail-outright behavior anyway.
   */
  isInteractive(): boolean;
  /**
   * Resolves to the chosen serial. Only ever called when `isInteractive()`
   * just returned `true`, so `undefined` here means something did go wrong
   * mid-prompt (e.g. stdin closed while waiting) rather than "can't prompt
   * at all" — a real implementation should still keep re-prompting on
   * merely invalid input (a typo, an out-of-range number) rather than
   * giving up and returning `undefined` for that, which would make
   * `android.ts` report its non-interactive-environment message for what's
   * actually just a fixable mistake.
   */
  pick(choices: DeviceChoice[]): Promise<string | undefined>;
}
