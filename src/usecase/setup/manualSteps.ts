import { manualSetupInstructions } from '../../domain/setup/instructions';
import type { InstructionContext } from '../../domain/setup/instructions';
import type { SetupTarget } from '../../domain/setup/targets';
import type { SetupMode, SetupStep } from './types';

/** `setup`'s instructions are already imperative ("Trust the CA cert: ...", "Configure the proxy: ...") so need no prefix; `doctor`'s get reworded into something checkable. `cleanup` needs none either — it uses `proxyCleanup` instead of `proxyConfig`, already phrased as its own "Turn the proxy off: ..." action, not `proxyConfig`'s "turn it on" one. */
const MODE_PREFIX: Record<SetupMode, string> = { setup: '', doctor: 'Verify: ', cleanup: '' };

/**
 * Turns `domain/setup/instructions.ts`'s manual instructions into
 * `'manual'` `SetupStep`s for `target`. Used both by `orchestrator.ts`'s
 * fallback for targets with no automation at all (currently just windows)
 * and by `ios.ts`, which automates the Simulator but still has no way to
 * touch a physical device — its manual steps are these same lines, appended
 * after whatever Simulator automation ran.
 *
 * `cleanup` gets only `proxyCleanup`, never `certTrust` or `proxyConfig`:
 * `cleanup` never touches CA cert trust (every automated target's cleanup
 * function leaves it alone too — see e.g. `mac.ts`'s `runMacCleanup`), and
 * `proxyConfig` is phrased as turning the proxy *on* (to detour) — showing
 * either under a "cleanup" heading would contradict what cleanup actually
 * does or reads backwards.
 */
export function manualSteps(mode: SetupMode, target: SetupTarget, instructionCtx: InstructionContext): SetupStep[] {
  const prefix = MODE_PREFIX[mode];
  const instructions = manualSetupInstructions(target, instructionCtx);
  const messages =
    mode === 'cleanup' ? [instructions.proxyCleanup] : [instructions.certTrust, instructions.proxyConfig];
  return messages.map((message) => ({ status: 'manual', message: prefix + message }));
}
