import { manualSetupInstructions } from '../../domain/setup/instructions';
import type { InstructionContext } from '../../domain/setup/instructions';
import type { SetupTarget } from '../../domain/setup/targets';
import type { SetupMode, SetupStep } from './types';

/** Reworded per `mode` so the same instruction text reads naturally whether it's telling you to *do* something (`setup`), *check* something (`doctor`), or *undo* something (`cleanup`). */
const MODE_PREFIX: Record<SetupMode, string> = { setup: '', doctor: 'Verify: ', cleanup: 'Undo manually: ' };

/**
 * Turns `domain/setup/instructions.ts`'s plain instruction lines into
 * `'manual'` `SetupStep`s for `target`. Used both by `orchestrator.ts`'s
 * fallback for targets with no automation at all (currently just windows)
 * and by `ios.ts`, which automates the Simulator but still has no way to
 * touch a physical device — its manual steps are these same lines, appended
 * after whatever Simulator automation ran.
 */
export function manualSteps(mode: SetupMode, target: SetupTarget, instructionCtx: InstructionContext): SetupStep[] {
  const prefix = MODE_PREFIX[mode];
  return manualSetupInstructions(target, instructionCtx).map((message) => ({
    status: 'manual',
    message: prefix + message,
  }));
}
