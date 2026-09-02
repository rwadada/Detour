import { describe, expect, it } from 'vitest';
import { DEFAULT_THROTTLE_STATE, normalizeThrottleState } from './throttlePolicy';

describe('DEFAULT_THROTTLE_STATE', () => {
  it('is a true no-op: disabled, every rate/delay zero', () => {
    expect(DEFAULT_THROTTLE_STATE).toEqual({ enabled: false, downKbps: 0, upKbps: 0, latencyMs: 0, packetLossPct: 0 });
  });
});

describe('normalizeThrottleState', () => {
  it('clamps negative/non-finite values to 0', () => {
    const result = normalizeThrottleState({
      enabled: true,
      downKbps: -5,
      upKbps: NaN,
      latencyMs: -1,
      packetLossPct: -10,
    });
    expect(result).toEqual({ enabled: true, downKbps: 0, upKbps: 0, latencyMs: 0, packetLossPct: 0 });
  });

  it('clamps packetLossPct to a maximum of 100', () => {
    const result = normalizeThrottleState({ enabled: true, downKbps: 0, upKbps: 0, latencyMs: 0, packetLossPct: 150 });
    expect(result.packetLossPct).toBe(100);
  });

  it('passes valid values through unchanged', () => {
    const state = { enabled: true, downKbps: 500, upKbps: 200, latencyMs: 100, packetLossPct: 5 };
    expect(normalizeThrottleState(state)).toEqual(state);
  });
});
