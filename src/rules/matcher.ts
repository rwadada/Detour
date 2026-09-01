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

/** Compiles a `*`/`?` wildcard pattern into a RegExp anchored to the whole string. */
export function compileGlob(pattern: string): RegExp {
  const source = pattern
    .split(/([*?])/)
    .map((part) => (part === '*' ? '.*' : part === '?' ? '.' : escapeRegExp(part)))
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

function normalizeMethods(method: RuleMatch['method']): string[] | undefined {
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
