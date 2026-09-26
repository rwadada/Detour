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

  // The response-describing fields (`status`/`statusMessage`/`headers`/
  // `body`/`bodyFile`) and `simulate` are mutually exclusive on a plain
  // mock action (see MockAction's own doc comment: `simulate` "wins over
  // status/headers/body/bodyFile" when set) — but a step overriding just
  // one of either side otherwise leaves whatever the *base* action set on
  // the other side still sitting on `merged`, invisible to the step's
  // author:
  //   - a step that sets, say, only `status` (meaning "actually respond
  //     for this call") while the base action set `simulate` would have
  //     that inherited `simulate` silently keep winning downstream
  //     (requestHandler.ts checks `mockAction.simulate` before ever
  //     resolving a response) — the step's override would never take
  //     effect at all. First caught (for `body`/`bodyFile` specifically)
  //     by agy code review, which then flagged the same gap for
  //     `status`/`statusMessage`/`headers` on a second pass.
  //   - a step that sets `simulate` while the base set response fields
  //     would leave those sitting on `merged` pointlessly (harmless
  //     downstream — `simulate` still wins — but an inconsistent,
  //     schema-invalid shape to hand around otherwise).
  // So whichever side a step actually touches replaces the other side
  // wholesale, rather than each field being inherited independently.
  // `delayMs` is deliberately not part of either group — it composes with
  // both a response and a `simulate` (delaying a timeout is meaningful
  // too), so it always just inherits/overrides normally via the spread.
  const stepSetsResponse =
    step.status !== undefined ||
    step.statusMessage !== undefined ||
    step.headers !== undefined ||
    step.body !== undefined ||
    step.bodyFile !== undefined;

  if (step.simulate !== undefined) {
    merged.status = undefined;
    merged.statusMessage = undefined;
    merged.headers = undefined;
    merged.body = undefined;
    merged.bodyFile = undefined;
  } else if (stepSetsResponse) {
    merged.simulate = undefined;
    // Within the response side, `body`/`bodyFile` are themselves a
    // mutually exclusive pair (bodyFile wins over body) — a step setting
    // only one of the two must not inherit the other from the base
    // action, or that precedence would pick whichever the step didn't
    // intend.
    if (step.body !== undefined || step.bodyFile !== undefined) {
      merged.body = step.body;
      merged.bodyFile = step.bodyFile;
    }
  }

  return merged;
}
