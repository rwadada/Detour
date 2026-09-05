import { Download } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { exchangesToHar, matchesFilters, useExchangeStore } from '@/entities/exchange';
import { downloadTextFile } from '@/shared/lib/downloadTextFile';
import { useDismissablePopover } from '@/shared/lib/useDismissablePopover';
import { Button } from '@/shared/ui';
import { exportFileName, serializeExchangesAsJson, serializeHar, type ExportFormat } from '../model/exportLog';

/**
 * Header control for exporting the captured log (issue #19): HAR 1.2 for
 * other HTTP-debugging tools, or Detour's own JSON export (re-importable by
 * `LogViewer`'s `ImportButton`). Mirrors `ThrottleControl`'s popover pattern.
 *
 * Exports whatever the toolbar's filter (method/status/URL substring) is
 * currently narrowing the log table down to, not the full unfiltered
 * capture — the common case this exists for is grabbing the one failing
 * request for a bug report, and silently attaching every unrelated exchange
 * alongside it (including whatever's in their headers/bodies) defeats that.
 * `SessionControl`'s "Save session" is the full-snapshot counterpart when
 * every captured exchange plus the live proxy environment is wanted instead.
 */
export function ExportMenu() {
  const exchanges = useExchangeStore((s) => s.exchanges);
  const filters = useExchangeStore((s) => s.filters);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useDismissablePopover(open, containerRef, () => setOpen(false));

  // Memoized: `open`/local popover state changes re-render this component far
  // more often than `exchanges`/`filters` actually change, and re-filtering
  // the whole capture on every one of those is an avoidable O(n) cost.
  const filtered = useMemo(() => exchanges.filter((e) => matchesFilters(e, filters)), [exchanges, filters]);
  const buttonTitle = exportButtonTitle(filtered.length, exchanges.length);

  const handleExport = (format: ExportFormat) => {
    const content = format === 'har' ? serializeHar(exchangesToHar(filtered)) : serializeExchangesAsJson(filtered);
    downloadTextFile(exportFileName(format), content);
    setOpen(false);
  };

  return (
    <div className="relative" ref={containerRef}>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen((v) => !v)}
        disabled={filtered.length === 0}
        title={buttonTitle}
      >
        <Download className="h-3.5 w-3.5" />
      </Button>
      {open && (
        <div className="absolute right-0 top-full z-10 mt-2 w-44 rounded-md border border-[var(--border)] bg-[var(--panel)] p-1 shadow-lg">
          {filtered.length !== exchanges.length && (
            <p className="px-2 py-1 text-[10px] text-[var(--muted)]">
              Exporting {filtered.length} of {exchanges.length} (current filter)
            </p>
          )}
          {/* Re-checked here, not just on the header button: the toolbar filter can
              change to match nothing while this popover is already open, and without
              this the menu would sit open with both actions still exporting an empty
              HAR/JSON. */}
          <button
            type="button"
            onClick={() => handleExport('har')}
            disabled={filtered.length === 0}
            className="block w-full rounded px-2 py-1.5 text-left text-xs text-[var(--foreground)] hover:bg-[var(--accent)]/10 disabled:pointer-events-none disabled:opacity-50"
          >
            Export as HAR
          </button>
          <button
            type="button"
            onClick={() => handleExport('json')}
            disabled={filtered.length === 0}
            className="block w-full rounded px-2 py-1.5 text-left text-xs text-[var(--foreground)] hover:bg-[var(--accent)]/10 disabled:pointer-events-none disabled:opacity-50"
          >
            Export as JSON
          </button>
        </div>
      )}
    </div>
  );
}

function exportButtonTitle(filteredCount: number, totalCount: number): string {
  if (filteredCount === 0) {
    // Distinguish "nothing captured yet" from "the current filter matches
    // nothing" — the fix for the latter is to clear/adjust the filter, not
    // to wait for traffic, and the button's disabled title is the only
    // place that's said since the button itself gives no other clue.
    return totalCount === 0 ? 'No captured requests to export' : 'No requests match the current filter';
  }
  if (filteredCount === totalCount) return 'Export the captured log';
  return `Export the ${filteredCount} request(s) matching the current filter`;
}
