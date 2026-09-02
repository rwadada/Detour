import type { ThrottleState } from '../exchange/types';

/** `enabled: false`, every rate/delay `0` — Throttle's true no-op default (see `ThrottleState`'s doc comment). */
export const DEFAULT_THROTTLE_STATE: ThrottleState = {
  enabled: false,
  downKbps: 0,
  upKbps: 0,
  latencyMs: 0,
  packetLossPct: 0,
};

/** Clamps a Throttle profile's numeric fields to sane, non-negative values — a stray negative from a malformed dashboard message would otherwise flip a bandwidth cap's "unlimited" check and speed traffic up instead of slowing it down. */
export function normalizeThrottleState(state: ThrottleState): ThrottleState {
  const nonNegative = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  return {
    enabled: state.enabled,
    downKbps: nonNegative(state.downKbps),
    upKbps: nonNegative(state.upKbps),
    latencyMs: nonNegative(state.latencyMs),
    packetLossPct: Math.min(100, nonNegative(state.packetLossPct)),
  };
}
