import { describe, expect, it } from 'vitest';
import type { Rule } from '../domain/rules/types';
import { resolveExchangeAction } from './resolveExchangeAction';
import type { MatchedRules } from '../domain/rules/matcher';
import type { RuleEngine } from './ruleEngine';

const mockRule: Rule = { name: 'm', match: { url: '*' }, action: { type: 'mock' } };
const routeRule: Rule = { name: 'r', match: { url: '*' }, action: { type: 'route', host: 'x' } };
const rewriteRule: Rule = {
  name: 'rw',
  match: { url: '*' },
  action: { type: 'rewrite', request: { headers: { set: { a: '1' } } } },
};

function fakeEngine(matched: MatchedRules): RuleEngine {
  return { matchAll: () => matched } as unknown as RuleEngine;
}

describe('resolveExchangeAction', () => {
  it('returns the matched terminal rule when intercept is on and the host is focused', () => {
    const result = resolveExchangeAction(fakeEngine({ rewrites: [], terminal: mockRule }), {
      method: 'GET',
      url: 'https://x/',
      host: 'x',
      interceptEnabled: true,
      focusHosts: [],
    });
    expect(result.terminal).toBe(mockRule);
  });

  it('returns every matching rewrite rule when intercept is on', () => {
    const result = resolveExchangeAction(fakeEngine({ rewrites: [rewriteRule], terminal: undefined }), {
      method: 'GET',
      url: 'https://x/',
      host: 'x',
      interceptEnabled: true,
      focusHosts: [],
    });
    expect(result.rewrites).toEqual([rewriteRule]);
  });

  it('drops a non-route terminal rule and all rewrites while intercept is off', () => {
    const result = resolveExchangeAction(fakeEngine({ rewrites: [rewriteRule], terminal: mockRule }), {
      method: 'GET',
      url: 'https://x/',
      host: 'x',
      interceptEnabled: false,
      focusHosts: [],
    });
    expect(result.terminal).toBeUndefined();
    expect(result.rewrites).toEqual([]);
  });

  it('keeps applying a route terminal rule even while intercept is off', () => {
    const result = resolveExchangeAction(fakeEngine({ rewrites: [], terminal: routeRule }), {
      method: 'GET',
      url: 'https://x/',
      host: 'x',
      interceptEnabled: false,
      focusHosts: [],
    });
    expect(result.terminal).toBe(routeRule);
  });

  it('drops a non-route terminal rule when the host is outside the Focus allowlist', () => {
    const result = resolveExchangeAction(fakeEngine({ rewrites: [], terminal: mockRule }), {
      method: 'GET',
      url: 'https://x/',
      host: 'unfocused.example.com',
      interceptEnabled: true,
      focusHosts: ['x'],
    });
    expect(result.terminal).toBeUndefined();
  });

  it('returns no rewrites/terminal when no rule engine is given', () => {
    const result = resolveExchangeAction(undefined, {
      method: 'GET',
      url: 'https://x/',
      host: 'x',
      interceptEnabled: true,
      focusHosts: [],
    });
    expect(result.terminal).toBeUndefined();
    expect(result.rewrites).toEqual([]);
  });
});
