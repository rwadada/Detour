import { isHostFocused } from '../domain/focus/focusPolicy';
import type { Rule } from '../domain/rules/types';
import type { RuleEngine } from './ruleEngine';

export interface ResolveExchangeActionInput {
  method: string;
  /** Fully-qualified URL, e.g. `https://api.example.com/users/1?x=2`. */
  url: string;
  /** Formatted like `domain/focus/focusPolicy.ts`'s `formatHostPort` — a bare hostname, or `host:port` when the port isn't the scheme's default. */
  host: string;
  interceptEnabled: boolean;
  focusHosts: readonly string[];
}

export interface ResolvedExchangeAction {
  /** Every matching `rewrite` rule to apply, in file order — see `MatchedRules`'s doc comment. Empty while intercept is off (a `rewrite` rule is treated the same as any other non-`route` rule then — see this module's own doc comment). */
  rewrites: Rule[];
  /** The matching `mock`/`route`/`breakpoint`/`script` rule (if any) that decides this exchange's fate. */
  terminal: Rule | undefined;
}

/**
 * Decides which rule(s) apply to a proxied HTTP(S) exchange, given the
 * current Intercept/Focus state. While intercept is off (globally, or for
 * this host via Focus), only a `route` rule keeps applying — mock/rewrite/
 * breakpoint/script rules are treated as if nothing matched, so the request
 * flows through untouched (see `InterceptState`/`FocusState`'s doc comments
 * in domain/exchange/types.ts).
 */
export function resolveExchangeAction(
  ruleEngine: RuleEngine | undefined,
  input: ResolveExchangeActionInput,
): ResolvedExchangeAction {
  const matched = ruleEngine?.matchAll({ method: input.method, url: input.url });
  const focused = isHostFocused(input.focusHosts, input.host);
  const interceptActive = input.interceptEnabled && focused;
  const terminal = matched?.terminal;
  return {
    rewrites: interceptActive ? (matched?.rewrites ?? []) : [],
    terminal: interceptActive || terminal?.action.type === 'route' ? terminal : undefined,
  };
}
