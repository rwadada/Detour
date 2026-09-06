import type { CertPairingServer } from '../ports/certPairingServer';
import type { CommandRunner } from '../ports/commandRunner';
import type { DevicePicker } from '../ports/devicePicker';

/** Which of `detour setup`/`doctor`/`cleanup` is running — lives here (rather than only in `orchestrator.ts`, which is its main consumer) so `manualSteps.ts` and per-target modules like `ios.ts` can depend on it too without an import cycle back through `orchestrator.ts`. */
export type SetupMode = 'setup' | 'doctor' | 'cleanup';

/** Inputs every per-target setup/doctor/cleanup function needs — assembled once by `usecase/setup/orchestrator.ts` from CLI options and OS facts, never re-derived deeper down. */
export interface SetupContext {
  /** Path to the CA cert on this machine (`ensureCaCert()`'s result). */
  certPath: string;
  /** Address the target should point its proxy at (see `usecase/setup/proxyAddress.ts`). */
  proxyHost: string;
  proxyPort: number;
  runner: CommandRunner;
  /** `process.platform` of the machine `detour` itself is running on — distinct from `target`, which is what's being set up (see `domain/setup/automation.ts`'s `hostPlatform`). */
  hostPlatform: NodeJS.Platform;
  /** Only `android.ts`'s no-`adb` Wi-Fi/QR pairing fallback uses this — injected here anyway (rather than as its own separate parameter) to keep every per-target function's signature the same. */
  certPairingServer: CertPairingServer;
  /** Only `android.ts`'s `requireOneDevice` uses this, when more than one `adb` device is connected — injected here anyway for the same reason as `certPairingServer` above. */
  devicePicker: DevicePicker;
  /** True only for `detour <mode> --target <one target>` — false for the blanket "every target" sweep. Gates `android.ts`'s QR pairing fallback, which blocks waiting for a phone to scan a code: fine when the user explicitly asked to set up Android, surprising as a multi-minute hang buried inside a plain `detour setup`. */
  explicitTarget: boolean;
  /**
   * Called the moment a step is ready, *before* any further waiting a
   * per-target function does after producing it — currently only
   * `android.ts`'s Wi-Fi/QR pairing fallback uses this, to show the QR
   * code right away instead of only after its up-to-3-minute wait for a
   * download finishes (every other step here resolves quickly enough that
   * "print it once everything's done" — `cli.ts`'s normal
   * `printTargetReports` pass over the final `TargetOutcome` — is already
   * fine). Optional because most contexts (every unit test in this
   * directory, any future non-interactive caller) have nothing to do with
   * a step before the batch is complete.
   */
  onProgress?: (step: SetupStep) => void | Promise<void>;
}

export type StepStatus = 'done' | 'skipped' | 'failed' | 'manual';

export interface SetupStep {
  status: StepStatus;
  /** One line describing what this step did or why it didn't — no separate i18n layer, so this is the literal string the CLI prints. */
  message: string;
  /** Set only by `android.ts`'s QR pairing fallback — the URL to render as an ASCII QR code. Rendering itself happens in `cli.ts` (the composition root), never here: `usecase` may not depend on `presentation`, which is where `qrcode-terminal` lives (see `boundaries/dependencies` in eslint.config.mjs). */
  qrUrl?: string;
}

export interface TargetOutcome {
  steps: SetupStep[];
}
