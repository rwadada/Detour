import { History } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useExchangeStore } from '@/entities/exchange';
import { useDismissablePopover } from '@/shared/lib/useDismissablePopover';
import { Button, Input, PillToggle, Select } from '@/shared/ui';
import { useHistoryStore } from '../model/store';

const METHODS = ['ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/**
 * Toolbar control for the History feature (issue #144): queries exchanges
 * persisted via `detour start --persist`, beyond what the live dashboard's
 * in-memory backlog (500 items) still holds. Hidden entirely when this
 * session wasn't started with `--persist` (`historyStatus.enabled` false) —
 * offering a search that would always come back empty isn't useful.
 *
 * Entering/leaving history mode goes through `entities/exchange`'s
 * `importHistory`/`exitImport`, the same "swap the log table's data source"
 * mechanism `features/log-viewer`'s `ImportButton` uses for a loaded HAR
 * file — this is just a different (queried, paginated) source of exchanges
 * feeding the exact same table/inspector.
 */
export function HistoryControl() {
  const enabled = useHistoryStore((s) => s.enabled);
  const filters = useHistoryStore((s) => s.filters);
  const setFilters = useHistoryStore((s) => s.setFilters);
  const items = useHistoryStore((s) => s.items);
  const search = useHistoryStore((s) => s.search);
  const source = useExchangeStore((s) => s.source);
  const importHistory = useExchangeStore((s) => s.importHistory);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useDismissablePopover(open, containerRef, () => setOpen(false));

  // Keeps the log table's `exchanges` in sync with the History store's
  // results for as long as history mode is active (including a later
  // `HistoryBanner` "Load more") — gated on `source === 'history'` so this
  // never fires before the user has actually run a search (see `runSearch`,
  // which is what flips `source` into 'history' to begin with).
  useEffect(() => {
    if (source === 'history') importHistory(items);
  }, [items, source, importHistory]);

  if (!enabled) return null;

  const runSearch = () => {
    // Enters history mode immediately (an empty result the moment the
    // request goes out) rather than waiting for the reply — matches how a
    // live table clears instantly on Clear rather than staying stale until
    // the next event.
    importHistory([]);
    search();
    setOpen(false);
  };

  return (
    <div className="relative" ref={containerRef}>
      <PillToggle
        active={source === 'history'}
        onClick={() => setOpen((v) => !v)}
        icon={<History className="h-3 w-3" />}
        title="Search exchanges persisted via --persist, beyond the live backlog"
      >
        History
      </PillToggle>
      {open && (
        <div className="absolute right-0 top-full z-10 mt-2 w-64 rounded-md border border-[var(--border)] bg-[var(--panel)] p-2.5 shadow-lg">
          <p className="mb-2 text-xs text-[var(--muted)]">
            Search exchanges persisted to disk, including ones that already fell out of the live backlog above.
          </p>
          <div className="flex flex-col gap-2">
            <Select
              value={filters.method ?? 'ANY'}
              onChange={(e) => setFilters({ method: e.target.value === 'ANY' ? undefined : e.target.value })}
            >
              {METHODS.map((m) => (
                <option key={m} value={m}>
                  {m === 'ANY' ? 'Method: Any' : m}
                </option>
              ))}
            </Select>
            <Input
              value={filters.host ?? ''}
              onChange={(e) => setFilters({ host: e.target.value || undefined })}
              placeholder="Host (exact, e.g. api.example.com)"
            />
            <Input
              value={filters.urlContains ?? ''}
              onChange={(e) => setFilters({ urlContains: e.target.value || undefined })}
              placeholder="URL contains…"
            />
            <Button variant="outline" size="sm" onClick={runSearch}>
              Search
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
