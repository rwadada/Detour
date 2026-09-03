import { create } from 'zustand';
import type { DashboardConnection, ThrottleState } from '@/shared/api';

/** Throttle's true no-op default (see `shared/api/protocol.ts`'s `ThrottleState`) — used until the server's own `throttle` message arrives. */
export const DEFAULT_THROTTLE_STATE: ThrottleState = {
  enabled: false,
  downKbps: 0,
  upKbps: 0,
  latencyMs: 0,
  packetLossPct: 0,
};

export interface ThrottleStoreState {
  throttle: ThrottleState;
  setThrottle: (state: ThrottleState) => void;
}

/**
 * Builds the Throttle feature's store: simulated degraded network
 * conditions (bandwidth cap, latency, packet loss) on proxied traffic
 * (issue #13) — see `shared/api/protocol.ts`'s `ThrottleState` doc comment.
 *
 * `connection` is a required parameter (no default) precisely so importing
 * this module never has the side effect of opening a real WebSocket — see
 * `features/throttle/index.ts`, which wires the app's real singleton.
 */
export function createThrottleStore(connection: DashboardConnection) {
  return create<ThrottleStoreState>((set) => {
    connection.onMessage((message) => {
      if (message.type !== 'throttle') return;
      set({ throttle: message.state });
    });

    return {
      throttle: DEFAULT_THROTTLE_STATE,
      setThrottle: (state) => connection.send({ type: 'setThrottle', state }),
    };
  });
}
