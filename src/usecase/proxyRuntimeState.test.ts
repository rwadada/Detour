import { describe, expect, it } from 'vitest';
import { DEFAULT_THROTTLE_STATE } from '../domain/throttle/throttlePolicy';
import { ProxyRuntimeState } from './proxyRuntimeState';

describe('ProxyRuntimeState', () => {
  it('initializes with default values when no args provided', () => {
    const state = new ProxyRuntimeState();
    const snapshot = state.getSnapshot();

    expect(snapshot.ruleEngine).toBeUndefined();
    expect(snapshot.interceptEnabled).toBe(true);
    expect(snapshot.focusHosts).toEqual([]);
    expect(snapshot.throttleState).toEqual(DEFAULT_THROTTLE_STATE);
    expect(snapshot.blockHostsState).toEqual({ hosts: [], mode: 'forbidden' });
  });

  it('initializes with provided partial values', () => {
    const state = new ProxyRuntimeState({
      interceptEnabled: false,
      focusHosts: ['example.com'],
    });
    const snapshot = state.getSnapshot();

    expect(snapshot.interceptEnabled).toBe(false);
    expect(snapshot.focusHosts).toEqual(['example.com']);
    expect(snapshot.throttleState).toEqual(DEFAULT_THROTTLE_STATE);
  });

  it('updates state and returns updated snapshot', () => {
    const state = new ProxyRuntimeState();

    state.update({ interceptEnabled: false });
    expect(state.getSnapshot().interceptEnabled).toBe(false);

    state.update({ focusHosts: ['api.test'] });
    expect(state.getSnapshot().focusHosts).toEqual(['api.test']);
    expect(state.getSnapshot().interceptEnabled).toBe(false);

    state.update({
      blockHostsState: { hosts: ['bad.com'], mode: 'reset' },
      throttleState: { ...DEFAULT_THROTTLE_STATE, enabled: true, latencyMs: 50 },
    });
    expect(state.getSnapshot().blockHostsState).toEqual({ hosts: ['bad.com'], mode: 'reset' });
    expect(state.getSnapshot().throttleState.latencyMs).toBe(50);
  });

  it('guarantees snapshot immutability against caller mutations', () => {
    const state = new ProxyRuntimeState({
      focusHosts: ['initial.test'],
      throttleState: { ...DEFAULT_THROTTLE_STATE, latencyMs: 100 },
      blockHostsState: { hosts: ['block.test'], mode: 'forbidden' },
    });

    const snapshot = state.getSnapshot();
    // Attempt mutations on the returned snapshot
    (snapshot.focusHosts as string[]).push('mutated.test');
    snapshot.throttleState.latencyMs = 999;
    (snapshot.blockHostsState.hosts as string[]).push('mutated-block.test');

    const freshSnapshot = state.getSnapshot();
    expect(freshSnapshot.focusHosts).toEqual(['initial.test']);
    expect(freshSnapshot.throttleState.latencyMs).toBe(100);
    expect(freshSnapshot.blockHostsState.hosts).toEqual(['block.test']);
  });
});
