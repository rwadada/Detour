import { isHostBlocked } from '../domain/blockHosts/blockHostsPolicy';
import type { BlockHostsState } from '../domain/exchange/types';
import type { Rule } from '../domain/rules/types';
import type { ProxyRuntimeSnapshot } from './proxyRuntimeState';
import { resolveExchangeAction } from './resolveExchangeAction';

export interface RequestTarget {
  readonly method: string;
  readonly url: string;
  readonly host: string;
}

export type RequestAction =
  | {
      readonly kind: 'block';
      readonly mode: BlockHostsState['mode'];
      readonly ruleName: string;
    }
  | {
      readonly kind: 'mock';
      readonly terminal: Rule;
      readonly rewrites: readonly Rule[];
      readonly ruleName: string | undefined;
    }
  | {
      readonly kind: 'pause';
      readonly terminal: Rule;
      readonly rewrites: readonly Rule[];
      readonly ruleName: string | undefined;
    }
  | {
      readonly kind: 'script';
      readonly terminal: Rule;
      readonly rewrites: readonly Rule[];
      readonly ruleName: string | undefined;
    }
  | {
      readonly kind: 'route';
      readonly terminal: Rule;
      readonly rewrites: readonly Rule[];
      readonly ruleName: string | undefined;
    }
  | {
      readonly kind: 'forward';
      readonly terminal: Rule | undefined;
      readonly rewrites: readonly Rule[];
      readonly ruleName: string | undefined;
    };

/**
 * Pure decision function determining how an incoming request should be handled
 * (issue #208).
 * Evaluates Block Hosts, Intercept, Focus, and Rule Engine rules to decide the
 * terminal action (block, mock, pause, script, route, or forward) and any rewrite rules.
 */
export function decideRequestAction(snapshot: ProxyRuntimeSnapshot, target: RequestTarget): RequestAction {
  if (isHostBlocked(snapshot.blockHostsState.hosts, target.host)) {
    return {
      kind: 'block',
      mode: snapshot.blockHostsState.mode,
      ruleName: `block-hosts (${snapshot.blockHostsState.mode})`,
    };
  }

  const { rewrites, terminal } = resolveExchangeAction(snapshot.ruleEngine, {
    method: target.method,
    url: target.url,
    host: target.host,
    interceptEnabled: snapshot.interceptEnabled,
    focusHosts: snapshot.focusHosts,
  });

  const ruleName = [...rewrites, ...(terminal ? [terminal] : [])].map((r) => r.name).join(', ') || undefined;

  if (terminal?.action.type === 'mock') {
    return { kind: 'mock', terminal, rewrites, ruleName };
  }

  if (terminal?.action.type === 'breakpoint' && terminal.action.request !== false) {
    return { kind: 'pause', terminal, rewrites, ruleName };
  }

  if (terminal?.action.type === 'script') {
    return { kind: 'script', terminal, rewrites, ruleName };
  }

  if (terminal?.action.type === 'route') {
    return { kind: 'route', terminal, rewrites, ruleName };
  }

  return { kind: 'forward', terminal, rewrites, ruleName };
}
