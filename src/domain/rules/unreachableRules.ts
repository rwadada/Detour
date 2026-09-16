import { normalizeMethods } from './matcher';
import type { Rule, RuleMatch } from './types';

export interface UnreachableRuleWarning {
  ruleName: string;
  ruleIndex: number;
  blockedByName: string;
  blockedByIndex: number;
  /** Pre-formatted for direct printing/display — every caller (CLI startup, `rules validate`, the dashboard) wants the same wording. */
  message: string;
}

/**
 * True if every request `b`'s method criteria would accept, `a`'s would
 * too — i.e. `a` can't reject anything `b` accepts. Reuses
 * `normalizeMethods` rather than reimplementing its "falsy scalar
 * (`undefined`/`''`) means any method" collapse: a hand-rolled version that
 * naively wrapped a bare `''` in `['']` would treat `{method: ['GET', '']}`
 * as covering `{method: ''}` (an actual "matches every method" rule) — a
 * real false positive, since a POST request matches the "any method" rule
 * but not the `['GET', '']` one.
 */
function methodAlwaysCovers(a: RuleMatch['method'], b: RuleMatch['method']): boolean {
  const aMethods = normalizeMethods(a);
  const bMethods = normalizeMethods(b);
  if (aMethods === undefined) return true;
  if (bMethods === undefined) return false;
  const aSet = new Set(aMethods);
  return bMethods.every((m) => aSet.has(m));
}

/** A `g`/`y`-flagged regex is stateful (`RegExp.prototype.test` advances `lastIndex` across calls), and each rule's compiled `RegExp` is reused across every request for the process's lifetime — so two rules with byte-identical `urlRegex`/`urlRegexFlags` can still diverge on some request, since their `lastIndex` counters drift independently based on which requests each one was actually tested against. Excluded from the covering proof entirely rather than risk a false positive from a case that's genuinely provable most of the time. */
function hasStatefulRegexFlags(flags: string | undefined): boolean {
  return /[gy]/.test(flags ?? '');
}

/**
 * True if every request `b`'s URL criteria would match, `a`'s would too.
 * Only the handful of cases below are considered provable — anything else
 * (e.g. `a: "https://api.example.com/*"` vs `b: "https://api.example.com/users"`,
 * which `a` genuinely does always cover) returns `false` rather than risk a
 * false positive from reasoning about general glob/regex containment.
 */
function urlAlwaysCovers(a: RuleMatch, b: RuleMatch): boolean {
  // A literal `*` glob matches any run of characters, including none — the
  // one case simple enough to prove without comparing to `b` at all. (Not
  // quite "any string" in the strict regex sense: `^.*$` without the `s`
  // flag doesn't match a URL containing a raw CR/LF/line/paragraph
  // separator — but `req.url` is built from a parsed HTTP request line/Host
  // header, which can't legitimately contain one.)
  if (a.urlRegex === undefined && (a.url ?? '*') === '*') return true;
  if (a.urlRegex !== undefined && b.urlRegex !== undefined) {
    if (hasStatefulRegexFlags(a.urlRegexFlags) || hasStatefulRegexFlags(b.urlRegexFlags)) return false;
    return a.urlRegex === b.urlRegex && (a.urlRegexFlags ?? '') === (b.urlRegexFlags ?? '');
  }
  if (a.urlRegex === undefined && b.urlRegex === undefined) {
    return (a.url ?? '*') === (b.url ?? '*');
  }
  return false;
}

/**
 * Finds rules that can provably never run: a `rewrite` rule never stops
 * evaluation (see `findMatchingRules`'s doc comment), but the first
 * matching `mock`/`route`/`breakpoint`/`script` rule does — so a rule any
 * of those "terminal" types, positioned earlier and matching a superset of
 * a later rule's own criteria, permanently blocks that later rule from
 * ever being reached, whatever type it is.
 *
 * Deliberately conservative: only flags a rule when a blocker is
 * *provable* by exact-duplicate or catch-all matching (see
 * `urlAlwaysCovers`/`methodAlwaysCovers`) — general glob/regex overlap
 * detection is a much harder subset-of-a-language problem, and a false
 * positive here (telling a user a working rule is dead) is worse than
 * missing a real but harder-to-prove case.
 */
export function findUnreachableRules(rules: readonly Rule[]): UnreachableRuleWarning[] {
  const warnings: UnreachableRuleWarning[] = [];
  for (let j = 0; j < rules.length; j++) {
    const b = rules[j]!;
    if (b.enabled === false) continue;
    for (let i = 0; i < j; i++) {
      const a = rules[i]!;
      if (a.enabled === false || a.action.type === 'rewrite') continue;
      if (methodAlwaysCovers(a.match.method, b.match.method) && urlAlwaysCovers(a.match, b.match)) {
        warnings.push({
          ruleName: b.name,
          ruleIndex: j,
          blockedByName: a.name,
          blockedByIndex: i,
          message: `rule "${b.name}" (index ${j}) can never match: rule "${a.name}" (index ${i}) already matches every request "${b.name}" would, and — being a mock/route/breakpoint/script rule — stops evaluation there.`,
        });
        break;
      }
    }
  }
  return warnings;
}
