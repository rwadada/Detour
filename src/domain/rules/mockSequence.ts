import type { MockAction, MockStep } from './types';

/**
 * Picks the effective `mock` action for this rule's `callIndex`-th match
 * (0-based) — see `MockAction.responses`'s own doc comment for the overall
 * feature (issue #181). Pure: doesn't track the call count itself, just
 * applies one given by the caller — `RuleEngine` owns that state (keyed by
 * `Rule` object identity, reset on every reload), since a stateless
 * function has nowhere to keep it between calls anyway.
 *
 * Returns `action` unchanged when `responses` is absent/empty, so a plain
 * (non-sequential) mock rule is unaffected regardless of `callIndex`.
 */
export function pickMockAction(action: MockAction, callIndex: number): MockAction {
  const steps = action.responses;
  if (!steps || steps.length === 0) return action;

  const step = steps[Math.min(Math.max(callIndex, 0), steps.length - 1)] as MockStep;
  const merged: MockAction = { ...action, ...step, type: 'mock' };

  // A step that sets `body` or `bodyFile` means "this step's response body
  // is exactly this" — without this, a step setting only `bodyFile` while
  // the base action set `body` (or vice versa) would silently inherit the
  // other one too, and `resolveMockAction`'s "bodyFile wins over body"
  // precedence would then pick whichever of the two the step *didn't*
  // intend, rather than honoring the step at all.
  if (step.body !== undefined || step.bodyFile !== undefined) {
    merged.body = step.body;
    merged.bodyFile = step.bodyFile;
  }

  return merged;
}
