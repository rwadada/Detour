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

/**
 * Decides which rule (if any) applies to a proxied HTTP(S) exchange, given
 * the current Intercept/Focus state. While intercept is off (globally, or
 * for this host via Focus), only a `route` rule keeps applying — mock/
 * rewrite/breakpoint rules are treated as if nothing matched, so the request
 * flows through untouched (see `InterceptState`/`FocusState`'s doc comments
 * in domain/exchange/types.ts).
 */
export function resolveExchangeAction(
  ruleEngine: RuleEngine | undefined,
  input: ResolveExchangeActionInput,
): Rule | undefined {
  const matched = ruleEngine?.match({ method: input.method, url: input.url });
  const focused = isHostFocused(input.focusHosts, input.host);
  return (input.interceptEnabled && focused) || matched?.action.type === 'route' ? matched : undefined;
}
