import { create } from 'zustand';
import type { AutoPassthroughState, DashboardConnection } from '@/shared/api';

export interface AutoPassthroughStoreState {
  /** Mirrors the server's `autoPassthrough` message — `null` until one arrives (never, from a server without it). */
  autoPassthrough: AutoPassthroughState | null;
  /** Asks the server to forget every record; the answer is the next `autoPassthrough` message. */
  forgetAll: () => void;
}

/**
 * Auto TLS passthrough (issue #302): whether it is on, and which client/host/port targets are being relayed
 * untouched because their client refused Detour's certificate. Entries carry their own `expiresAt` and lapse
 * without a message, so a view filters them against the clock itself (`liveAutoPassthroughEntries`).
 *
 * `connection` is required (no default) so importing this module never opens a real WebSocket — see
 * `createInterceptStore`.
 */
export function createAutoPassthroughStore(connection: DashboardConnection) {
  return create<AutoPassthroughStoreState>((set) => {
    connection.onMessage((message) => {
      if (message.type !== 'autoPassthrough') return;
      set({ autoPassthrough: message.state });
    });

    return {
      autoPassthrough: null,
      forgetAll: () => connection.send({ type: 'forgetAutoPassthrough' }),
    };
  });
}

/** The entries not yet past their `expiresAt` at `now`, soonest to lapse first. */
export function liveAutoPassthroughEntries(state: AutoPassthroughState, now: number) {
  return state.entries.filter((entry) => entry.expiresAt > now).sort((a, b) => a.expiresAt - b.expiresAt);
}

/** `m:ss` until `expiresAt`, never negative. */
export function formatRemaining(expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
