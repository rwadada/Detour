import { useMemo } from 'react';
import { matchesFilters, useExchangeStore } from '@/entities/exchange';
import { PausedBreakpointsIndicator } from '@/features/breakpoint-resume';
import { CompareBar } from '@/features/compare';
import { cn } from '@/shared/lib/utils';

type Mode = 'live' | 'paused' | 'viewer';

/** `source === 'imported'` (viewing a saved log) takes priority over pause — the two are independent flags, but a paused live view and a viewed file both freeze the table, and "Viewer" is the more specific/useful label of the two. */
function deriveMode(source: 'live' | 'imported', paused: boolean): Mode {
  if (source === 'imported') return 'viewer';
  return paused ? 'paused' : 'live';
}

const MODE_LABEL: Record<Mode, string> = { live: 'Live', paused: 'Paused', viewer: 'Viewer' };
const MODE_TEXT_CLASS: Record<Mode, string> = {
  live: 'text-[var(--status-2xx)]',
  paused: 'text-[var(--status-4xx)]',
  viewer: 'text-[var(--accent)]',
};
const MODE_DOT_CLASS: Record<Mode, string> = {
  live: 'animate-pulse bg-[var(--status-2xx)]',
  paused: 'bg-[var(--status-4xx)]',
  viewer: 'bg-[var(--accent)]',
};

/**
 * Thin status strip between the toolbar and the log table (issue #24):
 * Live/Paused/Viewer, the visible row count, a summary of active filters,
 * and the Compare selection. Everything here is a summary of state owned
 * elsewhere (`entities/exchange`, `features/compare`) — this widget reads,
 * never writes.
 */
export function ContextBar() {
  const source = useExchangeStore((s) => s.source);
  const paused = useExchangeStore((s) => s.paused);
  const filters = useExchangeStore((s) => s.filters);
  const exchanges = useExchangeStore((s) => s.exchanges);
  const shownCount = useMemo(
    () => exchanges.reduce((n, e) => n + (matchesFilters(e, filters) ? 1 : 0), 0),
    [exchanges, filters],
  );
  const isFiltered = filters.method !== 'ALL' || filters.status !== 'ALL' || filters.query !== '';

  const mode = deriveMode(source, paused);

  return (
    <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-1 text-[10px] text-[var(--muted)]">
      <span className={cn('flex items-center gap-1 font-medium uppercase tracking-wide', MODE_TEXT_CLASS[mode])}>
        <span className={cn('h-1.5 w-1.5 rounded-full', MODE_DOT_CLASS[mode])} />
        {MODE_LABEL[mode]}
      </span>

      <span className="font-mono-ui">
        {isFiltered ? `${shownCount} of ${exchanges.length} shown` : `${exchanges.length} shown`}
      </span>

      {isFiltered && (
        <span className="truncate">
          {[
            filters.method !== 'ALL' && `Method: ${filters.method}`,
            filters.status !== 'ALL' && `Status: ${filters.status}`,
            filters.query && `URL contains "${filters.query}"`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      )}

      <div className="ml-auto flex items-center gap-2">
        <PausedBreakpointsIndicator />
        <CompareBar />
      </div>
    </div>
  );
}
