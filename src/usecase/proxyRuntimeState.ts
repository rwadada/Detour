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

function cloneSnapshot(snapshot: ProxyRuntimeSnapshot): ProxyRuntimeSnapshot {
  return {
    ...snapshot,
    focusHosts: [...snapshot.focusHosts],
    throttleState: { ...snapshot.throttleState },
    blockHostsState: {
      ...snapshot.blockHostsState,
      hosts: [...snapshot.blockHostsState.hosts],
    },
  };
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
      focusHosts: initial?.focusHosts ? [...initial.focusHosts] : [],
      throttleState: initial?.throttleState ? { ...initial.throttleState } : DEFAULT_THROTTLE_STATE,
      blockHostsState: initial?.blockHostsState
        ? { mode: initial.blockHostsState.mode, hosts: [...initial.blockHostsState.hosts] }
        : { hosts: [], mode: 'forbidden' },
    };
  }

  getSnapshot(): ProxyRuntimeSnapshot {
    return cloneSnapshot(this.current);
  }

  update(patch: Partial<ProxyRuntimeSnapshot>): void {
    this.current = {
      ...this.current,
      ...patch,
      ...(patch.focusHosts !== undefined ? { focusHosts: [...patch.focusHosts] } : {}),
      ...(patch.throttleState !== undefined ? { throttleState: { ...patch.throttleState } } : {}),
      ...(patch.blockHostsState !== undefined
        ? {
            blockHostsState: {
              mode: patch.blockHostsState.mode,
              hosts: [...patch.blockHostsState.hosts],
            },
          }
        : {}),
    };
  }
}
