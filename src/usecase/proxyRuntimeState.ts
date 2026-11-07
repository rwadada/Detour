import type { BlockHostsState, ThrottleState } from '../domain/exchange/types';
import { DEFAULT_THROTTLE_STATE } from '../domain/throttle/throttlePolicy';
import type { RuleEngine } from './ruleEngine';

export interface ProxyRuntimeSnapshot {
  readonly ruleEngine?: RuleEngine;
  readonly interceptEnabled: boolean;
  readonly focusHosts: readonly string[];
  readonly throttleState: ThrottleState;
  readonly blockHostsState: BlockHostsState;
}

/**
 * Manages mutable proxy runtime state (Intercept, Focus, Throttle, Block Hosts,
 * and RuleEngine) in a single unified container with snapshotting (issue #208).
 * Replaces distributing individual getters for each state variable.
 */
export class ProxyRuntimeState {
  private current: ProxyRuntimeSnapshot;

  constructor(initial?: Partial<ProxyRuntimeSnapshot>) {
    this.current = {
      ruleEngine: initial?.ruleEngine,
      interceptEnabled: initial?.interceptEnabled ?? true,
      focusHosts: initial?.focusHosts ?? [],
      throttleState: initial?.throttleState ?? DEFAULT_THROTTLE_STATE,
      blockHostsState: initial?.blockHostsState ?? { hosts: [], mode: 'forbidden' },
    };
  }

  getSnapshot(): ProxyRuntimeSnapshot {
    return this.current;
  }

  update(patch: Partial<ProxyRuntimeSnapshot>): void {
    this.current = { ...this.current, ...patch };
  }
}
