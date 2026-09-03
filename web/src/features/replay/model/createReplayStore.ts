import { create } from 'zustand';
import type { CapturedExchange, DashboardConnection } from '@/shared/api';

export interface ReplayState {
  /** Re-sends a previously captured exchange for real (issue #19) — the result appears as a new row in the log table once the server responds. */
  replay: (exchange: CapturedExchange) => void;
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
  return create<ReplayState>(() => ({
    replay: (exchange) => connection.send({ type: 'replay', exchange }),
  }));
}
