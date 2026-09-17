import { describe, expect, it } from 'vitest';
import { findUnreachableRules } from './unreachableRules';
import type { Rule } from './types';

function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    name: 'test-rule',
    match: { url: 'https://api.example.com/*' },
    action: { type: 'route', host: 'staging.example.com' },
    ...overrides,
  };
}

describe('findUnreachableRules', () => {
  it('flags an exact-duplicate match blocked by an earlier terminal rule', () => {
    const rules = [
      rule({ name: 'first', match: { url: 'https://api.example.com/x' }, action: { type: 'mock' } }),
      rule({ name: 'second', match: { url: 'https://api.example.com/x' }, action: { type: 'mock' } }),
    ];
    const warnings = findUnreachableRules(rules);
    expect(warnings).toEqual([
      expect.objectContaining({ ruleName: 'second', ruleIndex: 1, blockedByName: 'first', blockedByIndex: 0 }),
    ]);
  });

  it('flags a rule (of any type) after an earlier catch-all terminal rule', () => {
    const rules = [
      rule({ name: 'catch-all', match: { url: '*' }, action: { type: 'mock' } }),
      rule({
        name: 'narrow-rewrite',
        match: { url: 'https://api.example.com/x' },
        action: { type: 'rewrite', request: { headers: { set: { a: '1' } } } },
      }),
    ];
    const warnings = findUnreachableRules(rules);
    expect(warnings.map((w) => w.ruleName)).toEqual(['narrow-rewrite']);
  });

  it('does not flag a rewrite rule that matches everything — rewrite never stops evaluation', () => {
    const rules = [
      rule({
        name: 'catch-all-rewrite',
        match: { url: '*' },
        action: { type: 'rewrite', request: { headers: { set: { a: '1' } } } },
      }),
      rule({ name: 'reachable', match: { url: 'https://api.example.com/x' }, action: { type: 'mock' } }),
    ];
    expect(findUnreachableRules(rules)).toEqual([]);
  });

  it('does not flag two overlapping rewrite rules — both apply cumulatively now, neither is dead', () => {
    const rules = [
      rule({
        name: 'broad',
        match: { url: '*' },
        action: { type: 'rewrite', request: { headers: { set: { a: '1' } } } },
      }),
      rule({
        name: 'narrow',
        match: { url: 'https://api.example.com/x' },
        action: { type: 'rewrite', request: { headers: { set: { b: '2' } } } },
      }),
    ];
    expect(findUnreachableRules(rules)).toEqual([]);
  });

  it('does not flag a narrower glob fully covered by a broader one — not provable, so not reported', () => {
    const rules = [
      rule({ name: 'broad', match: { url: 'https://api.example.com/*' }, action: { type: 'mock' } }),
      rule({ name: 'narrow', match: { url: 'https://api.example.com/users' }, action: { type: 'mock' } }),
    ];
    expect(findUnreachableRules(rules)).toEqual([]);
  });

  it("skips a disabled blocker — it never runs, so it can't shadow anything", () => {
    const rules = [
      rule({ name: 'disabled-catch-all', match: { url: '*' }, enabled: false, action: { type: 'mock' } }),
      rule({ name: 'reachable', match: { url: 'https://api.example.com/x' }, action: { type: 'mock' } }),
    ];
    expect(findUnreachableRules(rules)).toEqual([]);
  });

  it('skips an already-disabled later rule — no need to report it as also shadowed', () => {
    const rules = [
      rule({ name: 'catch-all', match: { url: '*' }, action: { type: 'mock' } }),
      rule({ name: 'disabled', match: { url: 'https://api.example.com/x' }, enabled: false, action: { type: 'mock' } }),
    ];
    expect(findUnreachableRules(rules)).toEqual([]);
  });

  it('reports only the closest (first) blocker when multiple would shadow the same rule', () => {
    const rules = [
      rule({ name: 'first-catch-all', match: { url: '*' }, action: { type: 'mock' } }),
      rule({ name: 'second-catch-all', match: { url: '*' }, action: { type: 'mock' } }),
      rule({ name: 'dead', match: { url: 'https://api.example.com/x' }, action: { type: 'mock' } }),
    ];
    // `second-catch-all` is itself shadowed by `first-catch-all` too (both
    // are genuine catch-alls) — that's a separate, correct warning. What
    // this test actually checks is which blocker gets reported *for
    // `dead`*: the closest one (`first-catch-all`, index 0), not every
    // earlier rule that could also prove it.
    const warnings = findUnreachableRules(rules);
    const deadWarning = warnings.find((w) => w.ruleName === 'dead');
    expect(deadWarning?.blockedByName).toBe('first-catch-all');
    expect(warnings.filter((w) => w.ruleName === 'dead')).toHaveLength(1);
  });

  describe('method matching (false-positive regression: a bare "" scalar means "any method", but an array containing "" does not)', () => {
    it('does not flag a specific-method rule as blocked by a rule that only accepts an empty-string method', () => {
      // a.match.method = ['GET', ''] only ever matches a literal GET request
      // (no real request has method ''). b.match.method = '' matches ANY
      // method (normalizeMethods treats a falsy scalar as "no restriction").
      // A naive per-element normalize would wrongly conclude a covers b.
      const rules = [
        rule({ name: 'looks-broad-but-isnt', match: { method: ['GET', ''], url: '*' }, action: { type: 'mock' } }),
        rule({
          name: 'actually-any-method',
          match: { method: '', url: 'https://api.example.com/x' },
          action: { type: 'mock' },
        }),
      ];
      expect(findUnreachableRules(rules)).toEqual([]);
    });

    it('flags a rule blocked by an earlier rule with no method restriction at all', () => {
      const rules = [
        rule({ name: 'any-method', match: { url: '*' }, action: { type: 'mock' } }),
        rule({
          name: 'get-only',
          match: { method: 'GET', url: 'https://api.example.com/x' },
          action: { type: 'mock' },
        }),
      ];
      const warnings = findUnreachableRules(rules);
      expect(warnings.map((w) => w.ruleName)).toEqual(['get-only']);
    });

    it('does not flag a rule whose method the blocker does not accept', () => {
      const rules = [
        rule({ name: 'get-only', match: { method: 'GET', url: '*' }, action: { type: 'mock' } }),
        rule({
          name: 'post-only',
          match: { method: 'POST', url: 'https://api.example.com/x' },
          action: { type: 'mock' },
        }),
      ];
      expect(findUnreachableRules(rules)).toEqual([]);
    });

    it('matches methods case-insensitively, same as the real matcher', () => {
      const rules = [
        rule({ name: 'lower', match: { method: 'get', url: 'https://api.example.com/x' }, action: { type: 'mock' } }),
        rule({ name: 'upper', match: { method: 'GET', url: 'https://api.example.com/x' }, action: { type: 'mock' } }),
      ];
      const warnings = findUnreachableRules(rules);
      expect(warnings.map((w) => w.ruleName)).toEqual(['upper']);
    });
  });

  describe('regex matching', () => {
    it('flags an exact-duplicate urlRegex+flags blocked by an earlier terminal rule', () => {
      const rules = [
        rule({
          name: 'first',
          match: { urlRegex: '^https://api\\.example\\.com/x$', urlRegexFlags: 'i' },
          action: { type: 'mock' },
        }),
        rule({
          name: 'second',
          match: { urlRegex: '^https://api\\.example\\.com/x$', urlRegexFlags: 'i' },
          action: { type: 'mock' },
        }),
      ];
      const warnings = findUnreachableRules(rules);
      expect(warnings.map((w) => w.ruleName)).toEqual(['second']);
    });

    it('does not flag a byte-identical urlRegex when either rule sets the stateful `g` flag (false-positive regression)', () => {
      // RegExp.prototype.test with a `g`/`y` flag advances `lastIndex` across
      // calls; each rule's compiled RegExp is a separate, reused instance,
      // so two "identical" regexes can still diverge on some request based
      // on their independent call histories — see unreachableRules.ts's
      // hasStatefulRegexFlags doc comment.
      const rules = [
        rule({ name: 'first', match: { urlRegex: 'foo', urlRegexFlags: 'g' }, action: { type: 'mock' } }),
        rule({ name: 'second', match: { urlRegex: 'foo', urlRegexFlags: 'g' }, action: { type: 'mock' } }),
      ];
      expect(findUnreachableRules(rules)).toEqual([]);
    });

    it('does not flag a glob rule blocked by an earlier regex rule, even one that could arguably subsume it', () => {
      const rules = [
        rule({ name: 'catch-all-regex', match: { urlRegex: '.*' }, action: { type: 'mock' } }),
        rule({ name: 'glob', match: { url: 'https://api.example.com/x' }, action: { type: 'mock' } }),
      ];
      // A terminal, non-catch-all-glob `a` compared against a `b` that uses
      // the other pattern kind — deliberately not provable, exercising the
      // "one glob, one regex" fallback rather than a `url: '*'` short-circuit.
      expect(findUnreachableRules(rules)).toEqual([]);
    });
  });
});
