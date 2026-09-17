import { create } from 'zustand';
import type { CapturedExchange, DashboardConnection, HistoryFilters } from '@/shared/api';

const PAGE_SIZE = 100;

export interface HistoryState {
  /** Whether this session was started with `--persist` (issue #144) — from the server's `historyStatus`. Starts `false` until that message arrives, same "safer guess" default as `ProxyInfoState.dashboardOnLan`. */
  enabled: boolean;
  filters: HistoryFilters;
  items: CapturedExchange[];
  /** Whether an older page than `items`' current tail still exists — from the last `historyResult`'s own field. */
  hasMore: boolean;
  /** True while a `search`/`loadMore` request is in flight. */
  loading: boolean;
  setFilters: (patch: Partial<HistoryFilters>) => void;
  /** Runs the current `filters` from the top, replacing `items` entirely. */
  search: () => void;
  /** Fetches the next (older) page — using `items`' current oldest entry as the `before` cursor — and appends it to `items`. */
  loadMore: () => void;
  /** Clears `items`/`hasMore` — called when leaving history mode (see `exitImport`), so re-opening the feature later starts from a blank slate rather than stale results. */
  reset: () => void;
}

/**
 * Builds the History feature's store (issue #144): queries `--persist`-ed
 * exchanges beyond the live dashboard's in-memory backlog via `queryHistory`/
 * `historyResult`. Doesn't itself drive `entities/exchange`'s `importHistory`/
 * `exitImport` — the UI (`HistoryControl`/`HistoryBanner`) does that,
 * mirroring how `ImportButton` drives `importExchanges` directly rather than
 * `features/log-viewer` owning a dependency on `entities/exchange`'s store.
 *
 * `connection` is a required parameter (no default) precisely so importing
 * this module never has the side effect of opening a real WebSocket — see
 * `entities/exchange/model/createExchangeStore.ts`'s doc comment.
 */
export function createHistoryStore(connection: DashboardConnection) {
  // Scoped per store instance (not module-level) so independent instances —
  // e.g. one per test — never share state. Together, these two answer "is
  // this historyResult actually still the one I'm waiting for" (a stale
  // reply from a superseded query must never clobber `items`) and "was that
  // query a search (replace) or a loadMore (append)".
  let latestRequestId: string | null = null;
  let pendingKind: 'search' | 'loadMore' | null = null;
  let requestCounter = 0;

  return create<HistoryState>((set, get) => {
    connection.onMessage((message) => {
      if (message.type === 'historyStatus') {
        set({ enabled: message.enabled });
        return;
      }
      if (message.type !== 'historyResult' || message.requestId !== latestRequestId) return;
      set((state) => ({
        items: pendingKind === 'loadMore' ? [...state.items, ...message.items] : message.items,
        hasMore: message.hasMore,
        loading: false,
      }));
      pendingKind = null;
    });

    const runQuery = (kind: 'search' | 'loadMore') => {
      const state = get();
      requestCounter += 1;
      const requestId = `history-${requestCounter}`;
      latestRequestId = requestId;
      pendingKind = kind;
      const before =
        kind === 'loadMore' && state.items.length > 0 ? state.items[state.items.length - 1]!.startedAt : undefined;
      set({ loading: true });
      connection.send({ type: 'queryHistory', requestId, query: { ...state.filters, before, limit: PAGE_SIZE } });
    };

    return {
      enabled: false,
      filters: {},
      items: [],
      hasMore: false,
      loading: false,
      setFilters: (patch) => set((state) => ({ filters: { ...state.filters, ...patch } })),
      search: () => runQuery('search'),
      loadMore: () => runQuery('loadMore'),
      reset: () => {
        latestRequestId = null;
        pendingKind = null;
        set({ items: [], hasMore: false, loading: false });
      },
    };
  });
}
