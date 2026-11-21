import { create } from 'zustand';
import type { AutoPassthroughEntry, DashboardConnection } from '@/shared/api';

/** A record as this page keeps it: the server's `remainingMs` turned into a time on this page's own clock. */
export interface LocalAutoPassthroughEntry extends Omit<AutoPassthroughEntry, 'remainingMs'> {
  /** `Date.now()` (this page's clock) at which the record lapses. */
  expiresAt: number;
}

export interface LocalAutoPassthroughState {
  enabled: boolean;
  entries: LocalAutoPassthroughEntry[];
  /** Records the server holds in all; it sends at most the 100 soonest to lapse. */
  total: number;
}

export interface AutoPassthroughStoreState {
  /** Mirrors the server's `autoPassthrough` message — `null` until one arrives (never, from a server without it). */
  autoPassthrough: LocalAutoPassthroughState | null;
  /** Asks the server to forget every record; the answer is the next `autoPassthrough` message. */
  forgetAll: () => void;
}

/**
 * Auto TLS passthrough (issue #302): whether it is on, and which client/host/port targets are being relayed
 * untouched because their client refused Detour's certificate. The server sends how long each record has left;
 * it is anchored to this page's clock when the message arrives (so the two machines' clocks needn't agree), and
 * entries lapse without a message, so a view filters them against the clock itself (`liveAutoPassthroughEntries`).
 *
 * `connection` is required (no default) so importing this module never opens a real WebSocket — see
 * `createInterceptStore`. `now` is injectable for tests.
 */
export function createAutoPassthroughStore(connection: DashboardConnection, now: () => number = Date.now) {
  return create<AutoPassthroughStoreState>((set) => {
    connection.onMessage((message) => {
      if (message.type !== 'autoPassthrough') return;
      const receivedAt = now();
      const { enabled, entries, total } = message.state;
      set({
        autoPassthrough: {
          enabled,
          total,
          entries: entries.map(({ remainingMs, ...entry }) => ({ ...entry, expiresAt: receivedAt + remainingMs })),
        },
      });
    });

    return {
      autoPassthrough: null,
      forgetAll: () => connection.send({ type: 'forgetAutoPassthrough' }),
    };
  });
}

/** The entries not yet past their `expiresAt` at `now`, soonest to lapse first. */
export function liveAutoPassthroughEntries(state: LocalAutoPassthroughState, now: number): LocalAutoPassthroughEntry[] {
  return state.entries.filter((entry) => entry.expiresAt > now).sort((a, b) => a.expiresAt - b.expiresAt);
}

/** `m:ss` until `expiresAt`, never negative. */
export function formatRemaining(expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
