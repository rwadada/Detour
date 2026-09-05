import type { CommandRunner } from '../ports/commandRunner';

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
}

export type StepStatus = 'done' | 'skipped' | 'failed' | 'manual';

export interface SetupStep {
  status: StepStatus;
  /** One line describing what this step did or why it didn't — no separate i18n layer, so this is the literal string the CLI prints. */
  message: string;
}

export interface TargetOutcome {
  steps: SetupStep[];
}
