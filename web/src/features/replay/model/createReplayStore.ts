import { create } from 'zustand';
import type { CapturedExchange, DashboardConnection, ReplayOverrides } from '@/shared/api';

/** The server refused or failed a replay (`REPLAY_REJECTED` / `REPLAY_ERROR`); `seq` rises with each one so a form can tell a new failure from an old one. */
export interface ReplayFailure {
  seq: number;
  message: string;
}

export interface ReplayState {
  /** The most recent replay failure the server reported, or `null` if none yet. */
  failure: ReplayFailure | null;
  /** Re-sends a previously captured exchange for real (issue #19) — the result appears as a new row in the log table once the server responds. */
  replay: (exchange: CapturedExchange) => void;
  /** Edit & Send (issue #214): re-sends `exchange` with `overrides` applied; anything they leave out keeps the captured value. The result appears as a new row, linked to the original by `replayOf`. */
  replayEdited: (exchange: CapturedExchange, overrides: ReplayOverrides) => void;
}

/**
 * Builds the Replay feature's store. There's no state to read back here —
 * a replayed exchange just arrives over the wire as an ordinary `request`/
 * `response` pair `entities/exchange` already handles — but it still goes
 * through the `DashboardConnection` pattern (a factory taking `connection`,
 * not calling `getDashboardConnection()` directly) for the same reason
 * every other feature does: keeps this module import-safe for tests (see
 * `entities/exchange/model/createExchangeStore.ts`'s doc comment).
 */
export function createReplayStore(connection: DashboardConnection) {
  return create<ReplayState>((set) => {
    // Nothing else surfaces these (broadcast errors have no screen of their
    // own), and a refused Edit & Send that just does nothing looks broken.
    connection.onMessage((message) => {
      if (message.type !== 'error') return;
      if (message.event.errorKind !== 'REPLAY_REJECTED' && message.event.errorKind !== 'REPLAY_ERROR') return;
      set((state) => ({ failure: { seq: (state.failure?.seq ?? 0) + 1, message: message.event.message } }));
    });

    return {
      failure: null,
      replay: (exchange) => connection.send({ type: 'replay', exchange }),
      replayEdited: (exchange, overrides) => connection.send({ type: 'replay', exchange, overrides }),
    };
  });
}
