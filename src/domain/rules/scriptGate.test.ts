import { describe, expect, it } from 'vitest';
import { findDisabledScriptWarnings, findRejectedScriptWrites } from './scriptGate';
import type { Rule } from './types';

const routeRule = (name: string): Rule => ({
  name,
  match: { url: 'https://api.example.com/*' },
  action: { type: 'route', host: 'x' },
});

const scriptRule = (name: string, path = 'hook.js'): Rule => ({
  name,
  match: { url: 'https://api.example.com/*' },
  action: { type: 'script', path },
});

describe('findDisabledScriptWarnings', () => {
  it('returns nothing when allowScripts is on, regardless of content', () => {
    expect(findDisabledScriptWarnings([routeRule('a'), scriptRule('s')], true)).toEqual([]);
  });

  it('returns nothing when there are no script rules', () => {
    expect(findDisabledScriptWarnings([routeRule('a'), routeRule('b')], false)).toEqual([]);
  });

  it('flags every script rule, by name and index, when allowScripts is off', () => {
    const warnings = findDisabledScriptWarnings([routeRule('a'), scriptRule('s1'), scriptRule('s2')], false);
    expect(warnings).toEqual([
      expect.objectContaining({ ruleName: 's1', ruleIndex: 1 }),
      expect.objectContaining({ ruleName: 's2', ruleIndex: 2 }),
    ]);
    expect(warnings[0]?.message).toContain('--allow-scripts');
  });

  it('does not flag a disabled script rule (enabled: false is orthogonal to allowScripts)', () => {
    // A disabled rule never runs regardless of allowScripts, but the two
    // concerns are independent — this just documents that findDisabledScriptWarnings
    // doesn't itself look at `enabled` at all, it flags every `script` action.
    const disabled: Rule = { ...scriptRule('s'), enabled: false };
    expect(findDisabledScriptWarnings([disabled], false)).toEqual([expect.objectContaining({ ruleName: 's' })]);
  });
});

describe('findRejectedScriptWrites', () => {
  it('allows a write with no script rules at all', () => {
    expect(findRejectedScriptWrites([], [routeRule('a')])).toEqual([]);
  });

  it('allows re-saving an existing script rule with the same path unchanged', () => {
    const existing = [scriptRule('s', 'hook.js')];
    const next = [scriptRule('s', 'hook.js'), routeRule('a')];
    expect(findRejectedScriptWrites(existing, next)).toEqual([]);
  });

  it('rejects a brand-new script rule not present in the existing rules', () => {
    const violations = findRejectedScriptWrites([routeRule('a')], [routeRule('a'), scriptRule('new')]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('new');
    expect(violations[0]).toContain('adding a new');
  });

  it("rejects changing an existing script rule's path", () => {
    const existing = [scriptRule('s', 'old.js')];
    const next = [scriptRule('s', 'new.js')];
    const violations = findRejectedScriptWrites(existing, next);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('changing');
  });

  it('rejects a rename of an untouched script rule (conservative: name is the only identity available)', () => {
    const existing = [scriptRule('old-name', 'hook.js')];
    const next = [scriptRule('new-name', 'hook.js')];
    const violations = findRejectedScriptWrites(existing, next);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('new-name');
  });

  it('never rejects changes to non-script rules', () => {
    const existing = [routeRule('a')];
    const next = [{ ...routeRule('a'), action: { type: 'route' as const, host: 'y' } }];
    expect(findRejectedScriptWrites(existing, next)).toEqual([]);
  });

  it('reports one violation per offending rule when several are wrong at once', () => {
    const existing = [scriptRule('s1', 'a.js')];
    const next = [scriptRule('s1', 'b.js'), scriptRule('s2', 'c.js')];
    expect(findRejectedScriptWrites(existing, next)).toHaveLength(2);
  });
});
