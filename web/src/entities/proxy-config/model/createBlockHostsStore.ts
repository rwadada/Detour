import { create } from 'zustand';
import type { BlockHostsState, DashboardConnection } from '@/shared/api';

/** Block Hosts' true no-op default (see `shared/api/protocol.ts`'s `BlockHostsState`) — used until the server's own `blockHosts` message arrives. */
export const DEFAULT_BLOCK_HOSTS_STATE: BlockHostsState = { hosts: [], mode: 'forbidden' };

export interface BlockHostsStoreState {
  blockHosts: BlockHostsState;
  setBlockHosts: (state: BlockHostsState) => void;
}

/**
 * Builds the Block Hosts feature's store: outright denies requests to a set
 * of `*`/`?` glob host patterns with a 403 response or a connection reset
 * (issue #14) — see `shared/api/protocol.ts`'s `BlockHostsState` doc comment.
 *
 * `connection` is a required parameter (no default) precisely so importing
 * this module never has the side effect of opening a real WebSocket — see
 * `features/block-hosts/index.ts`, which wires the app's real singleton.
 */
export function createBlockHostsStore(connection: DashboardConnection) {
  return create<BlockHostsStoreState>((set) => {
    connection.onMessage((message) => {
      if (message.type !== 'blockHosts') return;
      set({ blockHosts: message.state });
    });

    return {
      blockHosts: DEFAULT_BLOCK_HOSTS_STATE,
      setBlockHosts: (state) => connection.send({ type: 'setBlockHosts', state }),
    };
  });
}
