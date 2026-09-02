import { create } from 'zustand';
import type { DashboardConnection } from '@/shared/api';

export interface FocusStoreState {
  /** The "Focus" host allowlist. Empty means unrestricted — every host is intercepted. */
  focusHosts: string[];
  setFocus: (hosts: string[]) => void;
}

/**
 * Builds the Focus feature's store: restricts MITM interception to a set of
 * `*`/`?` glob host patterns instead of every host the proxy sees (issue
 * #12) — see `shared/api/protocol.ts`'s `FocusState` doc comment.
 *
 * `connection` is a required parameter (no default) precisely so importing
 * this module never has the side effect of opening a real WebSocket — see
 * `features/focus/index.ts`, which wires the app's real singleton.
 */
export function createFocusStore(connection: DashboardConnection) {
  return create<FocusStoreState>((set) => {
    connection.onMessage((message) => {
      if (message.type !== 'focus') return;
      set({ focusHosts: message.state.hosts });
    });

    return {
      focusHosts: [],
      setFocus: (hosts) => connection.send({ type: 'setFocus', hosts }),
    };
  });
}
