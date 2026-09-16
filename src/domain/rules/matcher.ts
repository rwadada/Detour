import type { Rule, RuleMatch } from './types';

export interface MatchableRequest {
  method: string;
  /** Fully-qualified URL, e.g. `https://api.example.com/users/1?x=2`. */
  url: string;
}

/** A rule with its match criteria pre-compiled, so matching a request is cheap per-request. */
export interface CompiledRule {
  rule: Rule;
  test(req: MatchableRequest): boolean;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function globTokenToRegExpSource(token: string): string {
  if (token === '*') return '.*';
  if (token === '?') return '.';
  return escapeRegExp(token);
}

/** Compiles a `*`/`?` wildcard pattern into a RegExp anchored to the whole string. */
export function compileGlob(pattern: string): RegExp {
  const source = pattern
    .split(/([*?])/)
    .map(globTokenToRegExpSource)
    .join('');
  return new RegExp(`^${source}$`);
}

function compileUrlTest(match: RuleMatch): (url: string) => boolean {
  if (match.urlRegex !== undefined) {
    const re = new RegExp(match.urlRegex, match.urlRegexFlags);
    return (url) => re.test(url);
  }
  const re = compileGlob(match.url ?? '*');
  return (url) => re.test(url);
}

/** Exported for `unreachableRules.ts`'s shadowing check, which needs the exact same "falsy scalar (`undefined`/`''`) means any method" collapse this uses — a hand-rolled copy would drift and risk a false positive (see that module's doc comment). */
export function normalizeMethods(method: RuleMatch['method']): string[] | undefined {
  if (!method) return undefined;
  const list = Array.isArray(method) ? method : [method];
  return list.map((m) => m.toUpperCase());
}

/** Pre-compiles a rule's `match` block so it can be tested against many requests cheaply. */
export function compileRule(rule: Rule): CompiledRule {
  const methods = normalizeMethods(rule.match.method);
  const urlTest = compileUrlTest(rule.match);
  return {
    rule,
    test(req) {
      if (methods && !methods.includes(req.method.toUpperCase())) return false;
      return urlTest(req.url);
    },
  };
}

/** Returns the first enabled rule matching `req`, in file order ("first match wins"). */
export function findMatchingRule(compiledRules: readonly CompiledRule[], req: MatchableRequest): Rule | undefined {
  for (const compiled of compiledRules) {
    if (compiled.rule.enabled !== false && compiled.test(req)) return compiled.rule;
  }
  return undefined;
}

export interface MatchedRules {
  /**
   * Every enabled, matching `rewrite` rule up to (not including) `terminal`,
   * in file order — a `rewrite` rule never stops evaluation, so a broad rule
   * (e.g. "add this header to every request") and a narrower one further
   * down (e.g. "also rewrite this one endpoint's query param") both apply
   * to the same request, rather than the narrower one being silently
   * shadowed. A user hit exactly this: a header rewrite matched, its badge
   * showed on the dashboard, but the actual header value never changed —
   * because a second, unrelated `rewrite` rule above it in the file had
   * already "won" under the old single-match rule and stopped evaluation.
   */
  rewrites: Rule[];
  /**
   * The first enabled, matching non-`rewrite` rule (`mock`/`route`/
   * `breakpoint`/`script`), if any — still genuinely "first match wins":
   * finding one stops evaluation, so any rule after it (rewrite or not)
   * is never checked.
   */
  terminal: Rule | undefined;
}

/**
 * Like `findMatchingRule`, but collects every matching `rewrite` rule
 * instead of stopping at the first one, since a `rewrite` action only ever
 * adds to a request/response rather than deciding its fate the way `mock`/
 * `route`/`breakpoint`/`script` do — see `MatchedRules`'s doc comment.
 */
export function findMatchingRules(compiledRules: readonly CompiledRule[], req: MatchableRequest): MatchedRules {
  const rewrites: Rule[] = [];
  for (const compiled of compiledRules) {
    if (compiled.rule.enabled === false || !compiled.test(req)) continue;
    if (compiled.rule.action.type === 'rewrite') {
      rewrites.push(compiled.rule);
      continue;
    }
    return { rewrites, terminal: compiled.rule };
  }
  return { rewrites, terminal: undefined };
}
