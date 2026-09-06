/** One selectable `adb` device, described for a human choosing between several. */
export interface DeviceChoice {
  serial: string;
  /** One-line description shown in the selection prompt — kind (emulator/real device), connection (USB/Wi-Fi), and any diagnostic warning (e.g. "mobile data is the active network, not Wi-Fi — the proxy setting below won't reach it"). Plain text; `usecase` builds it so `infra`'s picker implementations don't need their own opinion on what's worth surfacing. */
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
   * Resolves to the chosen serial, or `undefined` when this environment
   * can't actually prompt anyone (non-interactive stdin — CI, a script, a
   * piped invocation) — `android.ts` falls back to its original
   * fail-outright behavior in that case rather than hanging on a prompt
   * nobody can ever answer.
   */
  pick(choices: DeviceChoice[]): Promise<string | undefined>;
}
