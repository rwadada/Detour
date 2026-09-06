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
  /** Ids marked for Compare (issue #19), oldest first, capped at 2 — toggling a 3rd id drops the oldest. */
  compareIds: string[];
  /**
   * True while the toolbar's Pause/Tail control (issue #24) has frozen the
   * log table's view — traffic keeps being captured into the buffer
   * underneath exactly as always (so nothing is lost, and Live/Paused/
   * Compare/breakpoints keep working), only the `exchanges` snapshot stops
   * advancing until `togglePause` resumes it.
   */
  paused: boolean;
  select: (id: string | null) => void;
  setFilters: (patch: Partial<Filters>) => void;
  /** Adds/removes `id` from the compare set. */
  toggleCompare: (id: string) => void;
  /** Empties the compare set. */
  clearCompare: () => void;
  /** Empties the log table. Selection is cleared too; other entities/features (e.g. a still-paused breakpoint) are untouched — they reflect state that's still genuinely true server-side. */
  clear: () => void;
  /** Freezes/unfreezes the live view (issue #24's Pause/Tail toolbar control). Unfreezing immediately catches `exchanges` up to whatever accumulated in the buffer while paused, rather than waiting for the next incoming message. */
  togglePause: () => void;
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
  // Mirrors `importedExchanges`'s "freeze the view, keep buffering
  // underneath" pattern for Pause/Tail (issue #24) — a second, independent
  // reason `exchanges` might stop tracking `buffer` (a user can pause a
  // live view; imported mode is a different frozen view entirely, so the
  // two flags are orthogonal rather than one implying the other).
  let paused = false;

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
      if (importedExchanges === null && !paused) set({ exchanges: buffer.toArray() });
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
          if (importedExchanges === null && !paused) set({ exchanges: buffer.toArray() });
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
      compareIds: [],
      paused: false,
      select: (id) => set({ selectedId: id }),
      setFilters: (patch) => set((state) => ({ filters: { ...state.filters, ...patch } })),
      toggleCompare: (id) => set((state) => ({ compareIds: nextCompareIds(state.compareIds, id) })),
      clearCompare: () => set({ compareIds: [] }),
      clear: () => {
        buffer.clear();
        pendingUpserts = [];
        importedExchanges = null;
        set({ exchanges: [], selectedId: null, source: 'live', importedFileName: null, compareIds: [] });
      },
      togglePause: () =>
        set((state) => {
          paused = !state.paused;
          // Resuming: catch the frozen view up to whatever the buffer
          // accumulated while paused, immediately rather than waiting for
          // the next incoming message (which may be seconds away on quiet
          // traffic).
          return paused || importedExchanges !== null ? { paused } : { paused, exchanges: buffer.toArray() };
        }),
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

/** Toggles `id` in/out of a compare set, capping it at 2 by dropping the oldest entry. */
function nextCompareIds(current: string[], id: string): string[] {
  if (current.includes(id)) return current.filter((x) => x !== id);
  const next = [...current, id];
  return next.length > 2 ? next.slice(next.length - 2) : next;
}

// A closed passthrough tunnel never has (and never will have) a
// `statusCode` — it's not "pending" a response that just hasn't arrived
// yet, there was never an HTTP response to have one in the first place.
// Naively falling through to the `undefined` branch below would leave it
// permanently misclassified as `'pending'`, matching that filter forever.
// There's no real HTTP status class for it either, so this is deliberately
// not one of `Toolbar`'s selectable `STATUS_CLASSES` — it only ever shows
// under `filters.status === 'ALL'`, same as before this distinction existed
// for every other exchange kind.
function statusClass(exchange: CapturedExchange): string {
  if (isPassthroughDone(exchange)) return 'passthrough';
  if (exchange.statusCode === undefined) return 'pending';
  return `${Math.floor(exchange.statusCode / 100)}xx`;
}

export function matchesFilters(exchange: CapturedExchange, filters: Filters): boolean {
  if (filters.method !== 'ALL' && exchange.method !== filters.method) return false;
  if (filters.status !== 'ALL' && statusClass(exchange) !== filters.status) return false;
  if (filters.query && !exchange.url.toLowerCase().includes(filters.query.toLowerCase())) return false;
  return true;
}

/**
 * Whether a passthrough tunnel exchange (`CapturedExchange.passthrough`) has
 * actually closed. Its `statusCode` is never set even once it's done — that
 * field means something else entirely for a raw tunnel — so `finishedAt` is
 * what distinguishes an open one (still worth the same "pending" treatment
 * as any other in-flight exchange) from a closed one (which isn't pending,
 * and should render as `TLS` rather than an endless `···`). `false` for a
 * non-passthrough exchange, regardless of `finishedAt` — this question only
 * makes sense for a passthrough one.
 */
export function isPassthroughDone(exchange: CapturedExchange): boolean {
  return exchange.passthrough === true && exchange.finishedAt !== undefined;
}
