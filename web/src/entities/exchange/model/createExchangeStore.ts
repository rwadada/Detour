import { create } from 'zustand';
import { RingBuffer } from '@/shared/lib/ringBuffer';
import type { CapturedExchange, DashboardConnection } from '@/shared/api';

/** Bounds memory: with a ~1KB average exchange, this store's array itself never exceeds a few MB regardless of session length. */
const MAX_EXCHANGES = 5000;

export interface Filters {
  /** 'ALL' or an exact HTTP method. */
  method: string;
  /** 'ALL', 'pending', or a status class: '2xx' | '3xx' | '4xx' | '5xx'. */
  status: string;
  /** Case-insensitive substring match against the exchange URL. */
  query: string;
}

export const DEFAULT_FILTERS: Filters = { method: 'ALL', status: 'ALL', query: '' };

export interface ExchangeState {
  exchanges: CapturedExchange[];
  selectedId: string | null;
  filters: Filters;
  /** 'imported' while the LogViewer (issue #19) is showing a loaded HAR/JSON file instead of live traffic. */
  source: 'live' | 'imported';
  /** The imported file's name, for display in the "viewing a saved log" banner. Null outside imported mode. */
  importedFileName: string | null;
  select: (id: string | null) => void;
  setFilters: (patch: Partial<Filters>) => void;
  /** Empties the log table. Selection is cleared too; other entities/features (e.g. a still-paused breakpoint) are untouched — they reflect state that's still genuinely true server-side. */
  clear: () => void;
  /**
   * Switches the log table into "imported" mode, showing `exchanges` from a
   * loaded HAR/JSON file instead of live traffic (issue #19's LogViewer —
   * viewing a saved log without a running proxy). Live traffic keeps being
   * captured in the background so `exitImport` can return to it unchanged.
   */
  importExchanges: (exchanges: CapturedExchange[], fileName: string) => void;
  /** Leaves imported mode, restoring whatever live traffic accumulated in the background while a file was being viewed. */
  exitImport: () => void;
}

/**
 * Builds the exchange entity's store: the captured HTTP(S) traffic list,
 * selection, and filtering. Subscribes to the given `DashboardConnection`
 * for `backlog`/`request`/`response`/`breakpoint` messages (the last one
 * only for the transient exchange snapshot it carries — see
 * `features/breakpoint-resume` for the pause/resume payload itself).
 *
 * `connection` is a required parameter (no default) precisely so importing
 * this module never has the side effect of opening a real WebSocket — see
 * `entities/exchange/index.ts`, which wires the app's real singleton.
 */
export function createExchangeStore(connection: DashboardConnection) {
  // Scoped per store instance (not module-level) so independent instances —
  // e.g. one per test — never share state.
  const buffer = new RingBuffer<CapturedExchange>(MAX_EXCHANGES, (item) => item.id);
  let pendingUpserts: CapturedExchange[] = [];
  let flushHandle: number | undefined;
  // Non-null while in imported mode: the live buffer above keeps being
  // updated by WS traffic underneath, but `exchanges` shows this snapshot
  // instead until `exitImport` swaps back to `buffer.toArray()`.
  let importedExchanges: CapturedExchange[] | null = null;

  return create<ExchangeState>((set) => {
    // Incoming WS messages can arrive far faster than React should re-render
    // (a busy proxy can easily push hundreds of exchanges/sec). Rather than
    // calling `set()` per message, updates are queued here and flushed at
    // most once per animation frame.
    const flush = () => {
      flushHandle = undefined;
      if (pendingUpserts.length === 0) return;
      for (const item of pendingUpserts) buffer.upsert(item);
      pendingUpserts = [];
      if (importedExchanges === null) set({ exchanges: buffer.toArray() });
    };

    const scheduleFlush = () => {
      if (flushHandle === undefined) flushHandle = requestAnimationFrame(flush);
    };

    connection.onMessage((message) => {
      switch (message.type) {
        case 'backlog':
          buffer.clear();
          for (const item of message.items) buffer.upsert(item);
          pendingUpserts = [];
          if (importedExchanges === null) set({ exchanges: buffer.toArray() });
          return;
        case 'request':
        case 'response':
        case 'breakpoint':
          pendingUpserts.push(message.exchange);
          scheduleFlush();
          return;
        default:
          return;
      }
    });

    return {
      exchanges: [],
      selectedId: null,
      filters: DEFAULT_FILTERS,
      source: 'live',
      importedFileName: null,
      select: (id) => set({ selectedId: id }),
      setFilters: (patch) => set((state) => ({ filters: { ...state.filters, ...patch } })),
      clear: () => {
        buffer.clear();
        pendingUpserts = [];
        importedExchanges = null;
        set({ exchanges: [], selectedId: null, source: 'live', importedFileName: null });
      },
      importExchanges: (exchanges, fileName) => {
        importedExchanges = exchanges;
        set({ exchanges, selectedId: null, source: 'imported', importedFileName: fileName });
      },
      exitImport: () => {
        importedExchanges = null;
        set({ exchanges: buffer.toArray(), selectedId: null, source: 'live', importedFileName: null });
      },
    };
  });
}

function statusClass(status?: number): string {
  if (status === undefined) return 'pending';
  return `${Math.floor(status / 100)}xx`;
}

export function matchesFilters(exchange: CapturedExchange, filters: Filters): boolean {
  if (filters.method !== 'ALL' && exchange.method !== filters.method) return false;
  if (filters.status !== 'ALL' && statusClass(exchange.statusCode) !== filters.status) return false;
  if (filters.query && !exchange.url.toLowerCase().includes(filters.query.toLowerCase())) return false;
  return true;
}
