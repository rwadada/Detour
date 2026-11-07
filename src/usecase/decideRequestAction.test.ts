import { describe, expect, it } from 'vitest';
import type { MatchedRules } from '../domain/rules/matcher';
import type { Rule } from '../domain/rules/types';
import { DEFAULT_THROTTLE_STATE } from '../domain/throttle/throttlePolicy';
import { decideRequestAction, type RequestTarget } from './decideRequestAction';
import type { ProxyRuntimeSnapshot } from './proxyRuntimeState';
import type { RuleEngine } from './ruleEngine';

const baseSnapshot: ProxyRuntimeSnapshot = {
  interceptEnabled: true,
  focusHosts: [],
  throttleState: DEFAULT_THROTTLE_STATE,
  blockHostsState: { hosts: [], mode: 'forbidden' },
};

const defaultTarget: RequestTarget = {
  method: 'GET',
  url: 'http://example.com/api',
  host: 'example.com',
};

function fakeEngine(matched: MatchedRules): RuleEngine {
  return { matchAll: () => matched } as unknown as RuleEngine;
}

describe('decideRequestAction', () => {
  it('decides block when host matches Block Hosts', () => {
    const snapshot: ProxyRuntimeSnapshot = {
      ...baseSnapshot,
      blockHostsState: { hosts: ['example.com'], mode: 'reset' },
    };
    const action = decideRequestAction(snapshot, defaultTarget);
    expect(action).toEqual({
      kind: 'block',
      mode: 'reset',
      ruleName: 'block-hosts (reset)',
    });
  });

  it('decides forward when no rules match', () => {
    const action = decideRequestAction(baseSnapshot, defaultTarget);
    expect(action).toEqual({
      kind: 'forward',
      terminal: undefined,
      rewrites: [],
      ruleName: undefined,
    });
  });

  it('decides mock when terminal rule is mock', () => {
    const mockRule: Rule = {
      name: 'Mock Rule',
      match: { url: 'http://example.com/api' },
      action: { type: 'mock', status: 200, body: 'ok' },
    };
    const snapshot: ProxyRuntimeSnapshot = {
      ...baseSnapshot,
      ruleEngine: fakeEngine({ rewrites: [], terminal: mockRule }),
    };

    const action = decideRequestAction(snapshot, defaultTarget);
    expect(action).toEqual({
      kind: 'mock',
      terminal: mockRule,
      rewrites: [],
      ruleName: 'Mock Rule',
    });
  });

  it('decides pause when terminal rule is breakpoint with request enabled', () => {
    const bpRule: Rule = {
      name: 'BP Rule',
      match: { url: 'http://example.com/api' },
      action: { type: 'breakpoint', request: true, response: true },
    };
    const snapshot: ProxyRuntimeSnapshot = {
      ...baseSnapshot,
      ruleEngine: fakeEngine({ rewrites: [], terminal: bpRule }),
    };

    const action = decideRequestAction(snapshot, defaultTarget);
    expect(action).toEqual({
      kind: 'pause',
      terminal: bpRule,
      rewrites: [],
      ruleName: 'BP Rule',
    });
  });

  it('decides forward when breakpoint has request: false (only response breakpoint)', () => {
    const bpRule: Rule = {
      name: 'Response BP',
      match: { url: 'http://example.com/api' },
      action: { type: 'breakpoint', request: false, response: true },
    };
    const snapshot: ProxyRuntimeSnapshot = {
      ...baseSnapshot,
      ruleEngine: fakeEngine({ rewrites: [], terminal: bpRule }),
    };

    const action = decideRequestAction(snapshot, defaultTarget);
    expect(action).toEqual({
      kind: 'forward',
      terminal: bpRule,
      rewrites: [],
      ruleName: 'Response BP',
    });
  });

  it('decides script when terminal rule is script', () => {
    const scriptRule: Rule = {
      name: 'Script Rule',
      match: { url: 'http://example.com/api' },
      action: { type: 'script', path: 'hook.js' },
    };
    const snapshot: ProxyRuntimeSnapshot = {
      ...baseSnapshot,
      ruleEngine: fakeEngine({ rewrites: [], terminal: scriptRule }),
    };

    const action = decideRequestAction(snapshot, defaultTarget);
    expect(action).toEqual({
      kind: 'script',
      terminal: scriptRule,
      rewrites: [],
      ruleName: 'Script Rule',
    });
  });

  it('decides route when terminal rule is route', () => {
    const routeRule: Rule = {
      name: 'Route Rule',
      match: { url: 'http://example.com/api' },
      action: { type: 'route', host: 'internal.dev', port: 8080 },
    };
    const snapshot: ProxyRuntimeSnapshot = {
      ...baseSnapshot,
      ruleEngine: fakeEngine({ rewrites: [], terminal: routeRule }),
    };

    const action = decideRequestAction(snapshot, defaultTarget);
    expect(action).toEqual({
      kind: 'route',
      terminal: routeRule,
      rewrites: [],
      ruleName: 'Route Rule',
    });
  });

  it('includes rewrites and combines ruleNames', () => {
    const rewriteRule: Rule = {
      name: 'Rewrite 1',
      match: { url: 'http://example.com/api' },
      action: { type: 'rewrite', request: { headers: { set: { 'x-foo': 'bar' } } } },
    };
    const routeRule: Rule = {
      name: 'Route 1',
      match: { url: 'http://example.com/api' },
      action: { type: 'route', host: 'internal.dev' },
    };
    const snapshot: ProxyRuntimeSnapshot = {
      ...baseSnapshot,
      ruleEngine: fakeEngine({ rewrites: [rewriteRule], terminal: routeRule }),
    };

    const action = decideRequestAction(snapshot, defaultTarget);
    expect(action).toEqual({
      kind: 'route',
      terminal: routeRule,
      rewrites: [rewriteRule],
      ruleName: 'Rewrite 1, Route 1',
    });
  });
});
