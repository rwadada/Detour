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

  // `body`/`bodyFile`/`simulate` are a mutually exclusive trio on a plain
  // mock action (see MockAction's own doc comment: `simulate` "wins over
  // status/headers/body/bodyFile"; `bodyFile` wins over `body`) — but a
  // step only overriding *one* of the three otherwise leaves whichever of
  // the other two the *base* action set still sitting on `merged`, unseen
  // by the step's author:
  //   - a step that sets `body`/`bodyFile` while the base action set
  //     `simulate` would have that inherited `simulate` silently keep
  //     winning downstream (requestHandler.ts checks `mockAction.simulate`
  //     before ever resolving a body) — the step's body would never be
  //     sent, agy code review caught.
  //   - a step that sets only `bodyFile` while the base set `body` (or
  //     vice versa) would inherit the other one too, and `bodyFile`'s
  //     "wins over body" precedence would then pick whichever of the two
  //     the step didn't intend.
  //   - a step that sets `simulate` while the base set a body would leave
  //     that body sitting on `merged` pointlessly (harmless downstream —
  //     `simulate` still wins — but an inconsistent, unschema-valid shape
  //     to hand around otherwise).
  // So whichever of the two groups the step actually touches replaces the
  // other wholesale, rather than each field being inherited independently.
  if (step.simulate !== undefined) {
    merged.body = undefined;
    merged.bodyFile = undefined;
  } else if (step.body !== undefined || step.bodyFile !== undefined) {
    merged.body = step.body;
    merged.bodyFile = step.bodyFile;
    merged.simulate = undefined;
  }

  return merged;
}
