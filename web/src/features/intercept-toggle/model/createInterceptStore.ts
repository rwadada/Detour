import { create } from 'zustand';
import type { DashboardConnection } from '@/shared/api';

export interface InterceptState {
  /** Whether the proxy is actively intercepting traffic. Defaults to `true` until the server's own `intercept` message arrives. */
  interceptEnabled: boolean;
  setIntercept: (enabled: boolean) => void;
}

/**
 * Builds the Intercept feature's store: the master on/off switch (see
 * `shared/api/protocol.ts`'s `InterceptState` doc comment for what "off"
 * means for HTTPS/HTTP traffic).
 *
 * `connection` is a required parameter (no default) precisely so importing
 * this module never has the side effect of opening a real WebSocket — see
 * `features/intercept-toggle/index.ts`, which wires the app's real singleton.
 */
export function createInterceptStore(connection: DashboardConnection) {
  return create<InterceptState>((set) => {
    connection.onMessage((message) => {
      if (message.type !== 'intercept') return;
      set({ interceptEnabled: message.state.enabled });
    });

    return {
      interceptEnabled: true,
      setIntercept: (enabled) => connection.send({ type: 'setIntercept', enabled }),
    };
  });
}
