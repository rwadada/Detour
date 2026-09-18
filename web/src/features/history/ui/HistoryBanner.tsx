import { useExchangeStore } from '@/entities/exchange';
import { useHistoryStore } from '../model/store';

/**
 * Shown across the top of the app while the History feature (issue #144) is
 * displaying a `--persist` query's results instead of live traffic — mirrors
 * `features/log-viewer`'s `ImportedBanner`, plus a "Load more" button for
 * paging further back (an imported file, unlike a history query, is never
 * paginated).
 */
export function HistoryBanner() {
  const source = useExchangeStore((s) => s.source);
  const exitImport = useExchangeStore((s) => s.exitImport);
  const count = useExchangeStore((s) => s.exchanges.length);
  const hasMore = useHistoryStore((s) => s.hasMore);
  const loading = useHistoryStore((s) => s.loading);
  const loadMore = useHistoryStore((s) => s.loadMore);
  const reset = useHistoryStore((s) => s.reset);

  if (source !== 'history') return null;

  return (
    <div className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--accent)]/10 px-3 py-1.5 text-xs">
      <span className="text-[var(--foreground)]">
        Viewing <strong className="font-semibold">History</strong> ({count} result{count === 1 ? '' : 's'}
        {loading ? ', loading…' : ''}) — live capture is paused.
      </span>
      <div className="flex shrink-0 items-center gap-3">
        {hasMore && (
          <button
            type="button"
            onClick={loadMore}
            disabled={loading}
            className="rounded px-2 py-0.5 font-medium text-[var(--accent)] hover:bg-[var(--accent)]/20 disabled:opacity-50"
          >
            Load more
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            exitImport();
            reset();
          }}
          className="rounded px-2 py-0.5 font-medium text-[var(--accent)] hover:bg-[var(--accent)]/20"
        >
          Return to live
        </button>
      </div>
    </div>
  );
}
