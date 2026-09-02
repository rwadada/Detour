import { describe, expect, it } from 'vitest';
import type { Rule } from '../domain/rules/types';
import { resolveConnectRoute } from './resolveConnectRoute';
import type { RuleEngine } from './ruleEngine';

function fakeEngine(rule: Rule | undefined): RuleEngine {
  return { match: () => rule } as unknown as RuleEngine;
}

describe('resolveConnectRoute', () => {
  it('returns the route action when a route rule matches', () => {
    const routeRule: Rule = { name: 'r', match: { url: '*' }, action: { type: 'route', host: 'staging.example.com' } };
    expect(resolveConnectRoute(fakeEngine(routeRule), 'api.example.com', 443)).toEqual(routeRule.action);
  });

  it('returns undefined when the matched rule is not a route', () => {
    const mockRule: Rule = { name: 'm', match: { url: '*' }, action: { type: 'mock' } };
    expect(resolveConnectRoute(fakeEngine(mockRule), 'api.example.com', 443)).toBeUndefined();
  });

  it('returns undefined when no rule engine is given', () => {
    expect(resolveConnectRoute(undefined, 'api.example.com', 443)).toBeUndefined();
  });
});
