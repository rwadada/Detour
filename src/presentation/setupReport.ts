import { renderQrCode } from './qrCode';
import type { SetupMode, TargetReport } from '../usecase/setup/orchestrator';
import type { SetupStep, StepStatus, TargetOutcome } from '../usecase/setup/types';

/** One icon per `SetupStep['status']` — shared by `detour setup`/`doctor`/`cleanup`'s output (issue #65). */
function stepIcon(status: StepStatus): string {
  switch (status) {
    case 'done':
      return '✔';
    case 'failed':
      return '✖';
    case 'skipped':
      return '⚠';
    case 'manual':
      return 'ℹ';
  }
}

/**
 * Steps already shown live via `onProgress` (currently only android.ts's
 * Wi-Fi/QR pairing step) land in `printedLive` — `printTargetReports`'s
 * later pass over the same step objects (they're the very same `SetupStep`
 * returned inside the final `TargetOutcome`, not copies) skips them rather
 * than printing the message — and re-rendering the QR code — a second time.
 */
const printedLive = new WeakSet<SetupStep>();

/**
 * QR rendering (`qrcode-terminal`) lives in `presentation/`, which
 * `usecase/setup` may not depend on (see `boundaries/dependencies` in
 * eslint.config.mjs) — so a step that wants one just carries the URL
 * (`SetupStep.qrUrl`) and this function does the actual
 * rendering. Shared by `printTargetReports`'s final pass over a completed
 * `TargetOutcome` and by `runSetupCommand` (in `commands/setupCommand.ts`),
 * which passes this as its `onProgress` so a step is printed the moment
 * it's ready rather than only once everything is (see
 * `SetupContext.onProgress`'s doc comment — currently just android.ts's
 * Wi-Fi/QR pairing fallback, so its QR code is on screen before its own
 * multi-minute wait for a download, not just after).
 */
export async function printStep(step: SetupStep): Promise<void> {
  printedLive.add(step);
  console.log(`  ${stepIcon(step.status)} ${step.message}`);
  if (step.qrUrl) console.log(await renderQrCode(step.qrUrl));
}

/**
 * Trailing per-target line for `doctor` only, when its steps are all `✔`/`ℹ`
 * (no `failed` *or* `skipped`, so the summary doesn't compete with a
 * clearer problem — a `skipped` step, e.g. no booted iOS Simulator or an
 * explicit `--target` on the wrong host platform, means some checks never
 * ran at all, a different problem than "ran but can't be auto-verified"
 * that a plain manual-verification count would blur together) and at least
 * one is `ℹ` (`manual`) — `doctor`'s whole point is answering "is this
 * ready?", and a screen full of `✔` with one quiet `ℹ` mixed in (e.g.
 * android's cert-trust check, which needs root to verify over adb) reads as
 * "yes" at a glance even though that one thing was never actually
 * confirmed. Spelled out only for `doctor`: `setup`'s `manual` steps are
 * "go do this next", not "this wasn't checked", so they don't need the same
 * flagging.
 */
function doctorSummaryLine(outcome: TargetOutcome): string | undefined {
  const manualCount = outcome.steps.filter((s) => s.status === 'manual').length;
  if (manualCount === 0 || outcome.steps.some((s) => s.status === 'failed' || s.status === 'skipped')) {
    return undefined;
  }
  return manualCount === 1
    ? "  ℹ 1 check above needs manual verification — doctor can't confirm it automatically."
    : `  ℹ ${manualCount} checks above need manual verification — doctor can't confirm them automatically.`;
}

export async function printTargetReports(mode: SetupMode, reports: TargetReport[]): Promise<void> {
  for (const { target, outcome } of reports) {
    console.log(`\n${target}:`);
    for (const step of outcome.steps) {
      if (!printedLive.has(step)) await printStep(step);
    }
    if (mode === 'doctor') {
      const summary = doctorSummaryLine(outcome);
      if (summary) console.log(summary);
    }
  }
}

/** `detour doctor`'s (and, less commonly, `setup`/`cleanup`'s) exit code: nonzero when anything came back `'failed'`, so it's scriptable in CI the way `detour status` already is. */
export function hasFailedStep(reports: TargetReport[]): boolean {
  return reports.some(({ outcome }) => outcome.steps.some((step) => step.status === 'failed'));
}
