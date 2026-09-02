import { describe, expect, it } from 'vitest';
import type { Rule } from '../domain/rules/types';
import { resolveExchangeAction } from './resolveExchangeAction';
import type { RuleEngine } from './ruleEngine';

const mockRule: Rule = { name: 'm', match: { url: '*' }, action: { type: 'mock' } };
const routeRule: Rule = { name: 'r', match: { url: '*' }, action: { type: 'route', host: 'x' } };

function fakeEngine(rule: Rule | undefined): RuleEngine {
  return { match: () => rule } as unknown as RuleEngine;
}

describe('resolveExchangeAction', () => {
  it('returns the matched rule when intercept is on and the host is focused', () => {
    const rule = resolveExchangeAction(fakeEngine(mockRule), {
      method: 'GET',
      url: 'https://x/',
      host: 'x',
      interceptEnabled: true,
      focusHosts: [],
    });
    expect(rule).toBe(mockRule);
  });

  it('drops a non-route rule while intercept is off', () => {
    const rule = resolveExchangeAction(fakeEngine(mockRule), {
      method: 'GET',
      url: 'https://x/',
      host: 'x',
      interceptEnabled: false,
      focusHosts: [],
    });
    expect(rule).toBeUndefined();
  });

  it('keeps applying a route rule even while intercept is off', () => {
    const rule = resolveExchangeAction(fakeEngine(routeRule), {
      method: 'GET',
      url: 'https://x/',
      host: 'x',
      interceptEnabled: false,
      focusHosts: [],
    });
    expect(rule).toBe(routeRule);
  });

  it('drops a non-route rule when the host is outside the Focus allowlist', () => {
    const rule = resolveExchangeAction(fakeEngine(mockRule), {
      method: 'GET',
      url: 'https://x/',
      host: 'unfocused.example.com',
      interceptEnabled: true,
      focusHosts: ['x'],
    });
    expect(rule).toBeUndefined();
  });

  it('returns undefined when no rule engine is given', () => {
    const rule = resolveExchangeAction(undefined, {
      method: 'GET',
      url: 'https://x/',
      host: 'x',
      interceptEnabled: true,
      focusHosts: [],
    });
    expect(rule).toBeUndefined();
  });
});
