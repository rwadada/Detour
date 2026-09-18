import { describe, expect, it } from 'vitest';
import { compileGlob, compileRule, findMatchingRule, findMatchingRules } from './matcher';
import type { Rule } from './types';

describe('compileGlob', () => {
  it('matches `*` against any run of characters, including none', () => {
    const re = compileGlob('https://api.example.com/users/*');
    expect(re.test('https://api.example.com/users/1')).toBe(true);
    expect(re.test('https://api.example.com/users/')).toBe(true);
    expect(re.test('https://api.example.com/orders/1')).toBe(false);
  });

  it('matches `?` against exactly one character', () => {
    const re = compileGlob('https://api.example.com/v?/users');
    expect(re.test('https://api.example.com/v1/users')).toBe(true);
    expect(re.test('https://api.example.com/v12/users')).toBe(false);
    expect(re.test('https://api.example.com/v/users')).toBe(false);
  });

  it('escapes regex metacharacters in literal segments', () => {
    const re = compileGlob('https://api.example.com/a+b.json');
    expect(re.test('https://api.example.com/a+b.json')).toBe(true);
    // `.` and `+` must be literal, not "any char" / "one or more".
    expect(re.test('https://api.example.com/aXb.json')).toBe(false);
    expect(re.test('https://api.example.comXa+b.json')).toBe(false);
  });

  it('anchors the pattern to the whole string', () => {
    const re = compileGlob('foo');
    expect(re.test('foo')).toBe(true);
    expect(re.test('foobar')).toBe(false);
    expect(re.test('barfoo')).toBe(false);
  });
});

function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    name: 'test-rule',
    match: { url: 'https://api.example.com/*' },
    action: { type: 'route', host: 'staging.example.com' },
    ...overrides,
  };
}

describe('findMatchingRule', () => {
  it('returns the first enabled rule whose match criteria are satisfied', () => {
    const rules = [
      compileRule(rule({ name: 'a', match: { url: 'https://other.example.com/*' } })),
      compileRule(rule({ name: 'b', match: { url: 'https://api.example.com/*' } })),
      compileRule(rule({ name: 'c', match: { url: 'https://api.example.com/*' } })),
    ];
    const matched = findMatchingRule(rules, { method: 'GET', url: 'https://api.example.com/users/1' });
    expect(matched?.name).toBe('b');
  });

  it('skips disabled rules', () => {
    const rules = [compileRule(rule({ name: 'disabled', enabled: false })), compileRule(rule({ name: 'enabled' }))];
    const matched = findMatchingRule(rules, { method: 'GET', url: 'https://api.example.com/users/1' });
    expect(matched?.name).toBe('enabled');
  });

  it('matches methods case-insensitively', () => {
    const rules = [compileRule(rule({ match: { method: 'post', url: 'https://api.example.com/*' } }))];
    expect(findMatchingRule(rules, { method: 'POST', url: 'https://api.example.com/x' })).toBeDefined();
    expect(findMatchingRule(rules, { method: 'GET', url: 'https://api.example.com/x' })).toBeUndefined();
  });

  it('matches any of several methods when given an array', () => {
    const rules = [compileRule(rule({ match: { method: ['GET', 'HEAD'], url: 'https://api.example.com/*' } }))];
    expect(findMatchingRule(rules, { method: 'HEAD', url: 'https://api.example.com/x' })).toBeDefined();
    expect(findMatchingRule(rules, { method: 'DELETE', url: 'https://api.example.com/x' })).toBeUndefined();
  });

  it('matches with urlRegex instead of a glob', () => {
    const rules = [compileRule(rule({ match: { urlRegex: '^https://api\\.example\\.com/products/\\d+$' } }))];
    expect(findMatchingRule(rules, { method: 'GET', url: 'https://api.example.com/products/42' })).toBeDefined();
    expect(findMatchingRule(rules, { method: 'GET', url: 'https://api.example.com/products/abc' })).toBeUndefined();
  });

  it('returns undefined when nothing matches', () => {
    const rules = [compileRule(rule())];
    expect(findMatchingRule(rules, { method: 'GET', url: 'https://unrelated.example.com/x' })).toBeUndefined();
  });

  it('matches every request consistently with a stateful `g` urlRegexFlags, not just every other one (regression: RegExp.lastIndex must reset between requests)', () => {
    const rules = [
      compileRule(rule({ match: { urlRegex: 'https://api\\.example\\.com/orders', urlRegexFlags: 'g' } })),
    ];
    const req = { method: 'GET', url: 'https://api.example.com/orders' };
    // 3 calls against the exact same URL must all agree — a shared
    // RegExp's advancing `lastIndex` (unreset between calls) would instead
    // alternate matched/unmatched.
    expect(findMatchingRule(rules, req)).toBeDefined();
    expect(findMatchingRule(rules, req)).toBeDefined();
    expect(findMatchingRule(rules, req)).toBeDefined();
  });
});

describe('findMatchingRules', () => {
  it('collects every matching rewrite rule instead of stopping at the first (bug report: a broad header rewrite silently shadowed a narrower one below it)', () => {
    const rules = [
      compileRule(
        rule({ name: 'add-common-header', action: { type: 'rewrite', request: { headers: { set: { a: '1' } } } } }),
      ),
      compileRule(
        rule({ name: 'rewrite-param', action: { type: 'rewrite', request: { query: { set: { b: '2' } } } } }),
      ),
    ];
    const matched = findMatchingRules(rules, { method: 'GET', url: 'https://api.example.com/users/1' });
    expect(matched.rewrites.map((r) => r.name)).toEqual(['add-common-header', 'rewrite-param']);
    expect(matched.terminal).toBeUndefined();
  });

  it('stops at the first non-rewrite rule, excluding it and anything after from `rewrites`', () => {
    const rules = [
      compileRule(
        rule({ name: 'add-common-header', action: { type: 'rewrite', request: { headers: { set: { a: '1' } } } } }),
      ),
      compileRule(rule({ name: 'mock-it', action: { type: 'mock' } })),
      compileRule(
        rule({ name: 'never-reached', action: { type: 'rewrite', request: { headers: { set: { c: '3' } } } } }),
      ),
    ];
    const matched = findMatchingRules(rules, { method: 'GET', url: 'https://api.example.com/users/1' });
    expect(matched.rewrites.map((r) => r.name)).toEqual(['add-common-header']);
    expect(matched.terminal?.name).toBe('mock-it');
  });

  it('skips disabled rules the same as findMatchingRule', () => {
    const rules = [
      compileRule(
        rule({
          name: 'disabled',
          enabled: false,
          action: { type: 'rewrite', request: { headers: { set: { a: '1' } } } },
        }),
      ),
      compileRule(rule({ name: 'mock-it', action: { type: 'mock' } })),
    ];
    const matched = findMatchingRules(rules, { method: 'GET', url: 'https://api.example.com/users/1' });
    expect(matched.rewrites).toEqual([]);
    expect(matched.terminal?.name).toBe('mock-it');
  });

  it('returns no terminal when only rewrite rules match', () => {
    const rules = [
      compileRule(
        rule({ name: 'only-rewrite', action: { type: 'rewrite', request: { headers: { set: { a: '1' } } } } }),
      ),
    ];
    const matched = findMatchingRules(rules, { method: 'GET', url: 'https://api.example.com/users/1' });
    expect(matched.terminal).toBeUndefined();
  });
});
